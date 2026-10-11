#!/usr/bin/env node
// Tests for trailhead-secret-guard.js. Run: node trailhead-secret-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// TRAILHEAD_GUARD_HOOK re-runs this suite through the merged trailhead-bash-guards.js.
const HOOK = process.env.TRAILHEAD_GUARD_HOOK || path.join(__dirname, 'trailhead-secret-guard.js');
const { scan, ghIssueWrite, ghWrites, resolveBodyFile, bodyFileText } = require('./trailhead-secret-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Run the hook end-to-end: pipe tool_input JSON on stdin, capture {code, out}.
function runHook(command, env = {}, cwd) {
  const input = JSON.stringify({ tool_input: { command }, ...(cwd ? { cwd } : {}) });
  try {
    const out = execFileSync('node', [HOOK], { input, env: { ...process.env, ...env } });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}

// --- unit: scan() ---
ok('scan flags a GitHub token', scan('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx') === 'GitHub token');
ok('scan flags a private key', /private key/.test(scan('-----BEGIN RSA PRIVATE KEY-----') || ''));
ok('scan flags a hardcoded password', /password/.test(scan('db password=Sup3rSecretPass99') || ''));
ok('scan passes a redaction', scan('token: <REDACTED>') === null);
ok('scan passes an env ref', scan('use $SUPABASE_KEY here') === null);
ok('scan passes clean prose', scan('tutto ok, 368 test verdi') === null);

// --- unit: ghIssueWrite() ---
ok('detects gh issue comment', ghIssueWrite('gh issue comment 5 --body "x"') === 'issue');
ok('detects gh pr create', ghIssueWrite('gh pr create --body "x"') === 'pr');
ok('detects gh api body=', ghIssueWrite('gh api repos/o/r/issues/5/comments -f body=x') === 'api');
ok('detects gh -R o/r issue comment (global flag before subcommand)',
  ghIssueWrite('gh -R owner/repo issue comment 5 --body x') === 'issue');
ok('detects gh --repo=o/r pr create (attached global flag)',
  ghIssueWrite('gh --repo=owner/repo pr create --body x') === 'pr');
// Regression (#153): an unknown two-token global flag (e.g. --hostname h)
// before the subcommand must not desync the walk and hide the write.
ok('detects gh --hostname h issue comment (unknown two-token global flag)',
  ghIssueWrite('gh --hostname h issue comment 5 --body x') === 'issue');
// Regression (#153 follow-up): a two-token global flag whose VALUE literally
// equals a subcommand keyword must still resolve the real subcommand.
ok('detects gh --hostname api issue edit (flag value equals a keyword)',
  ghIssueWrite('gh --hostname api issue edit 5 --body x') === 'issue');
// Regression (#153 second follow-up): an unknown BOOLEAN flag directly
// before the subcommand must not swallow the subcommand as its own value.
ok('detects gh --foo issue edit (unknown boolean flag before the subcommand)',
  ghIssueWrite('gh --foo issue edit 5 --body x') === 'issue');
ok('ignores gh issue view (read)', ghIssueWrite('gh issue view 5 --json body') === null);
ok('ignores gh -R o/r issue view (read, even with global flag)',
  ghIssueWrite('gh -R owner/repo issue view 5 --json body') === null);
ok('ignores non-gh commands', ghIssueWrite('echo ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx') === null);

// --- unit: ghWrites() finds every write in a compound command ---
{
  const kinds = (c) => JSON.stringify(ghWrites(c).map((w) => w.kind));
  ok('ghWrites sees a write after D=/x &&', kinds('D=/x && gh issue comment 1 --body-file /x/b.md') === '["issue"]');
  ok('ghWrites sees a write after cd &&', kinds('cd /tmp && gh pr comment 1 --body x') === '["pr"]');
  ok('ghWrites sees a write after echo ;', kinds('echo x; gh issue edit 1 --body x') === '["issue"]');
  ok('ghWrites sees a write after a background &', kinds('true & gh issue comment 1 --body x') === '["issue"]');
  ok('ghWrites sees a write after a newline', kinds('echo x\ngh issue create --body x') === '["issue"]');
  ok('ghWrites returns both writes of one command',
    kinds('gh issue comment 1 --body a && gh pr review 2 --body b') === '["issue","pr"]');
  ok('ghWrites sees a gh api body= write behind &&', kinds('cd /x && gh api repos/o/r/issues/5/comments -f body=x') === '["api"]');
  ok('ghWrites ignores echo gh issue create', kinds('echo gh issue create --body x') === '[]');
  ok('ghWrites ignores ls && git status', kinds('ls && git status') === '[]');
  ok('ghWrites ignores a read behind &&', kinds('cd /x && gh issue view 5') === '[]');
  ok('ghIssueWrite returns the first write kind of a compound command',
    ghIssueWrite('cd /x && gh pr comment 1 --body x && gh issue edit 2 --body y') === 'pr');
  ok('ghIssueWrite still returns null for a compound with no write', ghIssueWrite('cd /x && ls') === null);
}

// --- unit: ghWrites() variable tracking (what each write can see) ---
{
  const w0 = (c, env = {}) => ghWrites(c, env)[0];
  ok('var set with ; reaches the write', w0('D=/x; gh issue comment 1 --body-file $D/b.md').vars.D === '/x');
  ok('var set with && reaches the write', w0('D=/x && gh issue comment 1 --body-file $D/b.md').vars.D === '/x');
  ok('export NAME=v sets a var', w0('export D=/x && gh issue comment 1 --body-file $D/b.md').vars.D === '/x');
  ok('single-quoted value stays literal', w0("D='$HOME'; gh issue comment 1 --body-file $D/b.md").vars.D === '$HOME');
  ok('double-quoted value expands known vars', w0('A=/x; D="$A/y"; gh issue comment 1 --body-file $D/b.md').vars.D === '/x/y');
  ok('bare value expands env and ~', w0('D=~/y; gh issue comment 1 --body-file $D/b.md', { HOME: '/h' }).vars.D === '/h/y');
  ok('an unresolvable value is recorded as null', w0('D=$(pwd); gh issue comment 1 --body-file $D/b.md').vars.D === null);
  ok('assignment ending in | does not propagate', !('D' in w0('D=/x | gh issue comment 1 --body-file $D/b.md').vars));
  ok('assignment ending in & does not propagate', !('D' in w0('D=/x & gh issue comment 1 --body-file $D/b.md').vars));
  ok('inline prefix does not propagate to the same statement', !('D' in w0('D=/x gh issue comment 1 --body-file "$D/a.md"').vars));
  ok('assignment after a pipe does not propagate', !('D' in w0('true | D=/x; gh issue comment 1 --body-file "$D/a.md"').vars));
  ok('cwd is known without a cd', w0('gh issue comment 1 --body x').cwdKnown === true);
  ok('cwd is unknown after cd', w0('cd /tmp && gh issue comment 1 --body x').cwdKnown === false);
  ok('cwd is unknown after pushd', w0('pushd /tmp; gh issue comment 1 --body x').cwdKnown === false);
}

// --- unit: resolveBodyFile() ---
{
  const r = (c, vars = {}, env = {}, cwd = '/work') => resolveBodyFile(c, vars, env, cwd);
  ok('no body-file flag -> null', r('gh issue comment 1 --body hi') === null);
  ok('stdin body file -> null', r('gh issue comment 1 --body-file -') === null);
  ok('literal absolute path', r('gh issue comment 1 --body-file /a/b.md').path === '/a/b.md');
  ok('-F short flag', r('gh issue comment 1 -F /a/b.md').path === '/a/b.md');
  ok('--body-file=path form', r('gh issue comment 1 --body-file=/a/b.md').path === '/a/b.md');
  ok('quoted path', r('gh issue comment 1 --body-file "/a b/c.md"').path === '/a b/c.md');
  ok('$NAME from vars', r('gh issue comment 1 --body-file $D/b.md', { D: '/x' }).path === '/x/b.md');
  ok('${NAME} in double quotes', r('gh issue comment 1 --body-file "${D}/b.md"', { D: '/x' }).path === '/x/b.md');
  ok('$NAME falls back to env', r('gh issue comment 1 --body-file $D/b.md', {}, { D: '/e' }).path === '/e/b.md');
  ok('vars win over env', r('gh issue comment 1 --body-file $D/b.md', { D: '/x' }, { D: '/e' }).path === '/x/b.md');
  ok('single-quoted path is literal', r("gh issue comment 1 --body-file '/l/$D/b.md'", { D: '/x' }).path === '/l/$D/b.md');
  ok('bare ~/ expands to HOME', r('gh issue comment 1 --body-file ~/b.md', {}, { HOME: '/h' }).path === '/h/b.md');
  ok('double-quoted ~ stays literal (relative to cwd)', r('gh issue comment 1 --body-file "~/b.md"', {}, { HOME: '/h' }).path === '/work/~/b.md');
  ok('relative path resolves against cwd', r('gh issue comment 1 --body-file b.md').path === '/work/b.md');
  ok('unknown variable is unresolved', !!r('gh issue comment 1 --body-file "$NOPE/b.md"').unresolved);
  ok('variable recorded as null is unresolved', !!r('gh issue comment 1 --body-file $D/b.md', { D: null }).unresolved);
  ok('command substitution is unresolved', !!r('gh issue comment 1 --body-file $(pwd)/b.md').unresolved);
  ok('backticks are unresolved', !!r('gh issue comment 1 --body-file `pwd`/b.md').unresolved);
  ok('parameter operator is unresolved', !!r('gh issue comment 1 --body-file ${D:-/x}/b.md', { D: '/x' }).unresolved);
  ok('positional/special params are unresolved', !!r('gh issue comment 1 --body-file $1').unresolved && !!r('gh issue comment 1 --body-file $@').unresolved && !!r('gh issue comment 1 --body-file $$').unresolved);
  ok('~user is unresolved', !!r('gh issue comment 1 --body-file ~bob/b.md').unresolved);
  ok('relative path with unknown cwd (after cd) is unresolved', !!r('gh issue comment 1 --body-file b.md', {}, {}, null).unresolved);
  ok('absolute path with unknown cwd still resolves', r('gh issue comment 1 --body-file /a/b.md', {}, {}, null).path === '/a/b.md');
  ok('attached -F/path (pflag shorthand) resolves like -F /path', r('gh issue comment 1 -F/a/b.md').path === '/a/b.md');
  ok('attached -F with a variable', r('gh issue comment 1 -F"$D"/b.md', { D: '/x' }).path === '/x/b.md');
  ok('/dev/stdin reads stdin -> null', r('gh issue comment 1 --body-file /dev/stdin') === null);
  ok('process substitution as body-file is unresolved', !!r('gh issue comment 1 --body-file <(cat /a/b.md)').unresolved);
  ok('a < redirect is not mistaken for the body-file', r('gh issue comment 1 -F - < /a/b.md') === null);
  ok('an absolute path is normalised', r('gh issue comment 1 --body-file /a/./c/../b.md').path === '/a/b.md');
  ok('adjacent quoted + bare parts join', r('gh issue comment 1 --body-file "$D"/b.md', { D: '/x' }).path === '/x/b.md');
}

// --- unit: ghWrites() sees writes inside compound constructs and wrappers (#210 review C1) ---
{
  const kinds = (c) => JSON.stringify(ghWrites(c).map((w) => w.kind));
  const W = 'gh issue comment 1 --body-file /x/b.md';
  ok('write after do', kinds(`for f in a; do ${W}; done`) === '["issue"]');
  ok('write after then', kinds(`if true; then ${W}; fi`) === '["issue"]');
  ok('write after else', kinds(`if false; then true; else ${W}; fi`) === '["issue"]');
  ok('write as an if condition', kinds(`if ${W}; then true; fi`) === '["issue"]');
  ok('write in a { } group', kinds(`{ ${W}; }`) === '["issue"]');
  ok('write in a ( ) subshell, spaced', kinds(`( ${W} )`) === '["issue"]');
  ok('write in a ( ) subshell, glued', kinds(`(${W})`) === '["issue"]');
  ok('write after !', kinds(`! ${W}`) === '["issue"]');
  ok('write after time', kinds(`time ${W}`) === '["issue"]');
  ok('write behind env', kinds(`env ${W}`) === '["issue"]');
  ok('write behind env -i NAME=v', kinds(`env -i A=1 ${W}`) === '["issue"]');
  ok('write behind command', kinds(`command ${W}`) === '["issue"]');
  ok('write behind builtin/nohup/exec',
    kinds(`nohup ${W}`) === '["issue"]' && kinds(`exec ${W}`) === '["issue"]' && kinds(`builtin ${W}`) === '["issue"]');
  ok('trailing ) of a subshell does not reach the path',
    ghWrites(`(${W})`)[0].text.endsWith('b.md') && ghWrites(`( ${W} )`)[0].text.endsWith('b.md'));
  ok('bash -c with a write is an opaque write', kinds(`bash -c '${W}'`) === '["opaque"]');
  ok('sh -c / zsh -c / eval / xargs with a write are opaque',
    kinds(`sh -c "${W}"`) === '["opaque"]' && kinds(`zsh -c "${W}"`) === '["opaque"]' &&
    kinds(`eval ${W}`) === '["opaque"]' && kinds(`echo 1 | xargs ${W}`) === '["opaque"]');
  ok('bash -c with a gh api body write is opaque', kinds('bash -c "gh api repos/o/r/issues/1/comments -f body=x"') === '["opaque"]');
  ok('a command substitution holding a write is analysed as that write', kinds(`echo $(${W})`) === '["issue"]');
  ok('a backtick substitution holding a write is analysed as that write', kinds(`echo \`${W}\``) === '["issue"]');
  ok('an assignment from a substitution holding a write is analysed', kinds(`URL=$(${W})`) === '["issue"]');
  ok('a nested bash -c inside a substitution is still opaque', kinds(`echo $(bash -c '${W}')`) === '["opaque"]');
  ok('bash -c with a read stays no write', kinds('bash -c "gh issue list"') === '[]' && kinds('bash -c "gh issue view 3 --comments"') === '[]');
  ok('bash -c without gh stays no write', kinds('bash -c "ls && echo hi"') === '[]');
  ok('prose about gh next to an unrelated substitution is not a write', kinds('echo "gh pr create" $(date)') === '[]');
  ok('a commit message heredoc mentioning gh issue comment is not a write',
    kinds("git commit -m \"$(cat <<'EOF'\nuse gh issue comment here\nEOF\n)\"") === '[]');
  ok('git commit message mentioning gh stays no write', kinds('git commit -m "docs: gh issue comment helper"') === '[]');
}

// --- unit: bodyFileText() is a thin wrapper over the resolver (#210 review I1) ---
{
  const leak = path.join(os.tmpdir(), `sg-i1-${process.pid}.md`);
  fs.writeFileSync(leak, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  ok('bodyFileText expands a variable set earlier in the command',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`D=${os.tmpdir()}; gh issue edit 5 --body-file $D/sg-i1-${process.pid}.md`)));
  ok('bodyFileText reads an attached -F/path', /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`gh issue edit 5 -F${leak}`)));
  ok('bodyFileText is empty without a body file', bodyFileText('gh issue edit 5 --body x') === '');
  let threw = false;
  try { bodyFileText('gh issue edit 5 --body-file "$SG_UNSET_VAR_210/x.md"'); } catch { threw = true; }
  ok('bodyFileText throws for an unresolvable path instead of reading it verbatim', threw);
  fs.unlinkSync(leak);
}

// --- end-to-end: block ---
const b1 = runHook('gh issue comment 5 --body "t ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx"');
ok('blocks an inline secret (exit 2)', b1.code === 2 && /"decision":"block"/.test(b1.out));

const b2 = runHook('gh api repos/o/r/issues/5/comments -f body=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dozjgNryP4J3jVmNHl0w5N');
ok('blocks a JWT via gh api (exit 2)', b2.code === 2 && /"decision":"block"/.test(b2.out));

// --- end-to-end: body-file ---
const leaky = path.join(os.tmpdir(), `sg-leaky-${process.pid}.md`);
fs.writeFileSync(leaky, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
const b3 = runHook(`gh issue comment 5 --body-file ${leaky}`);
ok('blocks a secret inside --body-file (exit 2)', b3.code === 2 && /AWS access key/.test(b3.out));
fs.unlinkSync(leaky);

// --- unit: bodyFileText() path extraction ---
// A bare path abutting a shell metacharacter in a compound command must NOT
// swallow the metacharacter into the filename (regression: `.md;` -> ENOENT).
{
  const leak = path.join(os.tmpdir(), `sg-meta-${process.pid}.md`);
  fs.writeFileSync(leak, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  ok('bare path stops at a trailing ; (compound command)',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`gh issue edit 5 --body-file ${leak}; echo done`)));
  ok('bare path stops at a trailing ) ',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`(gh issue edit 5 --body-file ${leak})`)));
  ok('bare path still works with a following && and space',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`gh issue edit 5 --body-file ${leak} && echo ok`)));
  // A quoted path keeps metacharacters verbatim (only the closing quote delimits).
  const quoted = path.join(os.tmpdir(), `sg;meta-${process.pid}.md`);
  fs.writeFileSync(quoted, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  ok('quoted path keeps an inner ; in the filename',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`gh issue edit 5 --body-file "${quoted}"`)));
  fs.unlinkSync(leak);
  fs.unlinkSync(quoted);
}

// End-to-end: the compound-command shape that produced the spurious advisory
// must now scan and BLOCK the real secret in the body.
const leaky2 = path.join(os.tmpdir(), `sg-leaky2-${process.pid}.md`);
fs.writeFileSync(leaky2, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
const b4 = runHook(`gh issue edit 5 --body-file ${leaky2}; echo done`);
ok('blocks a secret in --body-file even in a compound command (exit 2)',
  b4.code === 2 && /AWS access key/.test(b4.out));
fs.unlinkSync(leaky2);

// A global flag before the subcommand must not let a secret slip past unscanned.
const b5 = runHook('gh -R owner/repo issue comment 5 --body "t ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx"');
ok('blocks an inline secret behind gh -R (exit 2)', b5.code === 2 && /"decision":"block"/.test(b5.out));

// Regression (#153): an unknown two-token global flag (e.g. --hostname h)
// before the subcommand must not let a secret slip past unscanned either.
const b6 = runHook('gh --hostname h issue comment 5 --body "t ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx"');
ok('blocks an inline secret behind an unknown two-token global flag (--hostname h, exit 2)',
  b6.code === 2 && /"decision":"block"/.test(b6.out));

// Regression (#153 follow-up): a two-token global flag whose VALUE literally
// equals a subcommand keyword (`api`) must still be scanned as the real
// `issue edit` write, not slip past unscanned as a mis-resolved `api` write.
const b7 = runHook('gh --hostname api issue edit 5 --body "t ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx"');
ok('blocks an inline secret behind a keyword-valued two-token global flag (--hostname api, exit 2)',
  b7.code === 2 && /"decision":"block"/.test(b7.out));

// Regression (#153 second follow-up): an unknown BOOLEAN flag before the
// subcommand must not hide the write by swallowing the subcommand itself.
const b8 = runHook('gh --foo issue edit 5 --body "t ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx"');
ok('blocks an inline secret behind an unknown boolean flag (--foo, exit 2)',
  b8.code === 2 && /"decision":"block"/.test(b8.out));

// --- end-to-end: allow ---
const a1 = runHook('gh issue comment 5 --body "tutto ok, 368 test verdi"');
ok('allows a clean write (exit 0, no output)', a1.code === 0 && a1.out.trim() === '');
const a2 = runHook('gh issue view 5 --json body'); // read, never scanned
ok('allows a read (exit 0)', a2.code === 0 && a2.out.trim() === '');

// --- end-to-end: body-file paths with variables, compound commands (#210) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210-'));
  const leakFile = path.join(dir, 'leak.md');
  const cleanFile = path.join(dir, 'clean.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  fs.writeFileSync(cleanFile, 'all good, nothing sensitive here\n');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const code = (r, c) => r.code === 2 && r.out.includes(`"code":"${c}"`);
  const UNRES = 'SECRET_GUARD_UNRESOLVED_BODY_FILE';
  const UNREAD = 'SECRET_GUARD_UNREADABLE_BODY_FILE';

  ok('REPRO row 1: literal absolute body-file blocks', leaks(runHook(`gh issue comment 1 --body-file ${leakFile}`)));
  ok('REPRO row 2: D=dir; ... $D/leak.md blocks', leaks(runHook(`D=${dir}; gh issue comment 1 --body-file $D/leak.md`)));
  ok('REPRO row 3: D=dir && ... "${D}/leak.md" blocks', leaks(runHook(`D=${dir} && gh issue comment 1 --body-file "\${D}/leak.md"`)));
  ok('a body-file behind cd && blocks', leaks(runHook(`cd / && gh issue comment 1 --body-file ${leakFile}`)));
  ok('a body-file behind echo ; blocks', leaks(runHook(`echo hi; gh issue edit 1 --body-file ${leakFile}`)));
  ok('a body-file behind a background & blocks', leaks(runHook(`true & gh issue comment 1 --body-file ${leakFile}`)));
  ok('export D=dir && ... $D/leak.md blocks', leaks(runHook(`export D=${dir} && gh issue comment 1 --body-file $D/leak.md`)));
  ok('two writes: only the second body leaks -> blocks',
    leaks(runHook(`gh issue comment 1 --body-file ${cleanFile} && gh pr comment 2 --body-file ${leakFile}`)));
  ok('two writes: both clean -> allowed',
    (() => { const r = runHook(`gh issue comment 1 --body-file ${cleanFile} && gh pr comment 2 --body-file ${cleanFile}`); return r.code === 0 && r.out.trim() === ''; })());
  ok('a clean body via D=dir; ... $D/clean.md is allowed silently',
    (() => { const r = runHook(`D=${dir}; gh issue comment 1 --body-file $D/clean.md`); return r.code === 0 && r.out.trim() === ''; })());
  ok('a clean body via ~ expansion is allowed silently',
    (() => { const r = runHook('gh issue comment 1 --body-file ~/clean.md', { HOME: dir }); return r.code === 0 && r.out.trim() === ''; })());
  ok('an env-only variable resolves from the hook env',
    leaks(runHook('gh issue comment 1 --body-file "$SG_ENV_DIR/leak.md"', { SG_ENV_DIR: dir })));

  // Fail closed: a path we cannot know, or cannot read, never passes as a clean write.
  ok('an unset variable blocks as unresolved', code(runHook('gh issue comment 1 --body-file "$SG_UNSET_VAR_210/x.md"'), UNRES));
  ok('a command substitution blocks as unresolved', code(runHook('gh issue comment 1 --body-file $(pwd)/x.md'), UNRES));
  ok('a missing literal path blocks as unreadable', code(runHook(`gh issue comment 1 --body-file ${dir}/nope.md`), UNREAD));
  ok('a directory as body-file blocks as unreadable', code(runHook(`gh issue comment 1 --body-file ${dir}`), UNREAD));
  ok("D='$HOME' stays literal (unreadable, not expanded)", code(runHook("D='$HOME'; gh issue comment 1 --body-file $D/x.md", { HOME: dir }, dir), UNREAD));
  ok('"~/x" in double quotes stays literal (unreadable)', code(runHook('gh issue comment 1 --body-file "~/clean.md"', { HOME: dir }, dir), UNREAD));
  ok('an assignment piped into gh does not leak its variable', code(runHook(`SG_P=${dir} | gh issue comment 1 --body-file $SG_P/clean.md`), UNRES));
  ok('an inline prefix is not used to expand its own arguments', code(runHook(`SG_I=${dir} gh issue comment 1 --body-file "$SG_I/clean.md"`), UNRES));
  ok('an assignment after a pipe does not propagate', code(runHook(`true | SG_Q=${dir}; gh issue comment 1 --body-file "$SG_Q/clean.md"`), UNRES));
  ok('a relative path after cd blocks as unresolved', code(runHook('cd / && gh issue comment 1 --body-file clean.md', {}, dir), UNRES));

  // The hook input's cwd resolves a relative body-file path (single hook and merged runner).
  ok('a relative body-file resolves against the hook input cwd and blocks', leaks(runHook('gh issue comment 1 --body-file leak.md', {}, dir)));
  ok('a relative clean body-file resolves against the hook input cwd and passes',
    (() => { const r = runHook('gh issue comment 1 --body-file clean.md', {}, dir); return r.code === 0 && r.out.trim() === ''; })());

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- end-to-end: compound constructs and opaque writes (#210 review C1) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210c-'));
  const leakFile = path.join(dir, 'leak.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const W = `gh issue comment 1 --body-file ${leakFile}`;
  for (const [name, c] of [
    ['do', `for f in a; do ${W}; done`], ['then', `if true; then ${W}; fi`], ['{ }', `{ ${W}; }`],
    ['( )', `(${W})`], ['!', `! ${W}`], ['time', `time ${W}`], ['env', `env ${W}`], ['command', `command ${W}`],
  ]) ok(`a leaking body-file inside ${name} blocks`, leaks(runHook(c)));
  const op = runHook(`bash -c '${W}'`);
  ok('bash -c with a gh write blocks as opaque', op.code === 2 && op.out.includes('"code":"SECRET_GUARD_OPAQUE_WRITE"'));
  ok('eval with a gh write blocks as opaque', runHook(`eval ${W}`).out.includes('SECRET_GUARD_OPAQUE_WRITE'));
  const rd = runHook('bash -c "gh issue list"');
  ok('bash -c with a read is allowed silently', rd.code === 0 && rd.out.trim() === '');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- end-to-end: bodies that do not come from a literal file argument (#210 review W2) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210w2-'));
  const leakFile = path.join(dir, 'leak.md');
  const cleanFile = path.join(dir, 'clean.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  fs.writeFileSync(cleanFile, 'all good, nothing sensitive here\n');
  fs.writeFileSync(path.join(dir, 'leak.json'), '{"body":"AKIAIOSFODNN7EXAMPLE"}');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const unres = (r) => r.code === 2 && r.out.includes('"code":"SECRET_GUARD_UNRESOLVED_BODY_FILE"');
  const passes = (r) => r.code === 0 && r.out.trim() === '';
  const G = 'gh issue comment 1';

  // stdin: heredoc / herestring / redirect / pipe
  ok('stdin heredoc with a clean body passes', passes(runHook(`${G} -F - <<'EOF'\nhello world\nEOF`)));
  ok('stdin heredoc with a secret blocks (scanned in the command)', leaks(runHook(`${G} -F - <<'EOF'\nDeploy: AKIAIOSFODNN7EXAMPLE\nEOF`)));
  ok('stdin <<- heredoc passes', passes(runHook(`${G} --body-file - <<-EOF\n\thello\n\tEOF`)));
  ok('stdin herestring passes', passes(runHook(`${G} -F - <<< "hello"`)));
  ok('stdin < leak.md blocks', leaks(runHook(`${G} -F - < ${leakFile}`)));
  ok('stdin < clean.md passes', passes(runHook(`${G} -F - < ${cleanFile}`)));
  ok('/dev/stdin < leak.md blocks', leaks(runHook(`${G} --body-file /dev/stdin < ${leakFile}`)));
  ok('stdin < $UNSET blocks as unresolved', unres(runHook(`${G} -F - < "$SG_UNSET_VAR_210"`)));
  ok('stdin < relative path resolves against the hook cwd', leaks(runHook(`${G} -F - < leak.md`, {}, dir)));
  ok('cat leak.md | gh -F - blocks', leaks(runHook(`cat ${leakFile} | ${G} -F -`)));
  ok('cat clean.md | gh -F - passes', passes(runHook(`cat ${cleanFile} | ${G} -F -`)));
  ok('echo | gh -F - passes (inline content is scanned in the command)', passes(runHook(`echo hello | ${G} -F -`)));
  ok('echo secret | gh -F - blocks', leaks(runHook(`echo AKIAIOSFODNN7EXAMPLE | ${G} -F -`)));
  ok('printf | gh -F - passes', passes(runHook(`printf '%s' hello | ${G} -F -`)));
  ok('an unknown producer piped to gh -F - blocks as unresolved', unres(runHook(`curl -s http://x/y | ${G} -F -`)));
  ok('gh -F - with no stdin source at all passes', passes(runHook(`${G} -F -`)));

  ok('a leaking first of two --body-file flags still blocks', leaks(runHook(`${G} --body-file ${leakFile} --body-file ${cleanFile}`)));
  ok('a leaking -F next to --body-file blocks', leaks(runHook(`${G} --body-file ${cleanFile} -F ${leakFile}`)));

  // process substitution
  ok('--body-file <(...) blocks as unresolved', unres(runHook(`${G} --body-file <(cat ${leakFile})`)));

  // --body / -b values
  ok('-b "$(cat leak.md)" blocks', leaks(runHook(`${G} -b "$(cat ${leakFile})"`)));
  ok('--body "$(cat clean.md)" passes', passes(runHook(`${G} --body "$(cat ${cleanFile})"`)));
  ok('-b "$(<leak.md)" blocks', leaks(runHook(`${G} -b "$(<${leakFile})"`)));
  ok('unquoted -b $(cat leak.md) blocks', leaks(runHook(`${G} -b $(cat ${leakFile})`)));
  ok('--body "$(date)" blocks as unresolved', unres(runHook(`${G} --body "$(date)"`)));
  ok('--body with backticks blocks as unresolved', unres(runHook(`${G} --body "\`date\`"`)));
  ok('the heredoc-in-substitution idiom passes', passes(runHook(`${G} --body "$(cat <<'EOF'\nhello there\nEOF\n)"`)));
  ok('the heredoc-in-substitution idiom with a secret blocks', leaks(runHook(`${G} --body "$(cat <<'EOF'\nAKIAIOSFODNN7EXAMPLE\nEOF\n)"`)));
  ok('--body "$VAR" scans the expanded value', leaks(runHook(`${G} --body "$SG_BODY"`, { SG_BODY: 'AKIAIOSFODNN7EXAMPLE' })));
  ok('--body "$VAR" with a clean value passes', passes(runHook(`${G} --body "$SG_BODY"`, { SG_BODY: 'fine' })));
  ok('--body "$UNSET" blocks as unresolved', unres(runHook(`${G} --body "$SG_UNSET_VAR_210"`)));
  ok("--body 'literal $X' passes", passes(runHook(`${G} --body 'literal $X'`)));
  ok('B=...; --body "$B" scans the variable set in the command', leaks(runHook(`B=AKIAIOSFODNN7EXAMPLE; ${G} --body "$B"`)));

  // gh api
  const A = 'gh api repos/o/r/issues/1/comments';
  ok('api -F body=@leak.md blocks', leaks(runHook(`${A} -F body=@${leakFile}`)));
  ok('api --field body=@clean.md passes', passes(runHook(`${A} --field body=@${cleanFile}`)));
  ok('api -F body=@$D/leak.md resolves the variable', leaks(runHook(`D=${dir}; ${A} -F "body=@$D/leak.md"`)));
  ok('api -F body=@- reads stdin from a redirect', leaks(runHook(`${A} -F body=@- < ${leakFile}`)));
  ok('api -F body=@- with a heredoc passes', passes(runHook(`${A} -F body=@- <<'EOF'\nhello\nEOF`)));
  ok('api --input leak.json blocks (any method)', leaks(runHook(`gh api -X PATCH repos/o/r/issues/1 --input ${path.join(dir, 'leak.json')}`)));
  ok('api --input - < leak.json blocks', leaks(runHook(`gh api repos/o/r/issues/1 --input - < ${path.join(dir, 'leak.json')}`)));
  ok('api --input with an unresolvable path blocks', unres(runHook('gh api repos/o/r/issues/1 --input "$SG_UNSET_VAR_210"')));
  ok('api -f body=@leak.md is a raw field: literal, passes', passes(runHook(`${A} -f body=@${leakFile}`)));
  ok('api -f body=hi passes', passes(runHook(`${A} -f body=hi`)));
  ok('api read without body or --input is not a write', passes(runHook('gh api repos/o/r/issues/1')));

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- end-to-end: a body file written in the same command (#210 review W3) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210w3-'));
  const leakFile = path.join(dir, 'leak.md');
  const cleanFile = path.join(dir, 'clean.md');
  const N = path.join(dir, 'new.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  fs.writeFileSync(cleanFile, 'all good, nothing sensitive here\n');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const code = (r, c) => r.code === 2 && r.out.includes(`"code":"${c}"`);
  const passes = (r) => r.code === 0 && r.out.trim() === '';
  const G = `gh issue comment 1 --body-file ${N}`;

  ok('heredoc redirect then gh in the same command passes',
    passes(runHook(`cat > ${N} <<'EOF'\nhello world\nEOF\n${G}`)));
  ok('a secret in that heredoc blocks with SECRET_IN_ISSUE_WRITE',
    code(runHook(`cat > ${N} <<'EOF'\nAKIAIOSFODNN7EXAMPLE\nEOF\n${G}`), 'SECRET_IN_ISSUE_WRITE'));
  ok('a variable directory in the redirect path passes',
    passes(runHook(`S=${dir}; cat > $S/new.md <<'EOF'\nhello\nEOF\ngh issue comment 1 --body-file $S/new.md`)));
  ok('echo > path && gh passes', passes(runHook(`echo hello > ${N} && ${G}`)));
  ok('printf >> path; gh passes', passes(runHook(`printf '%s' hello >> ${N}; ${G}`)));
  ok('herestring redirect passes', passes(runHook(`cat > ${N} <<< "hello"\n${G}`)));
  ok('echo | tee path; gh passes', passes(runHook(`echo hello | tee ${N}; ${G}`)));
  ok('echo | tee -a path; gh passes', passes(runHook(`echo hello | tee -a ${N}; ${G}`)));
  ok('cat clean > path passes', passes(runHook(`cat ${cleanFile} > ${N} && ${G}`)));
  ok('cat leak > path blocks on the source', leaks(runHook(`cat ${leakFile} > ${N} && ${G}`)));
  ok('cp leak path blocks on the source', leaks(runHook(`cp ${leakFile} ${N} && ${G}`)));
  ok('cp clean path passes', passes(runHook(`cp ${cleanFile} ${N} && ${G}`)));
  ok('cat leak | tee path blocks on the source', leaks(runHook(`cat ${leakFile} | tee ${N}; ${G}`)));
  ok('a two-step copy chain blocks on the original source',
    leaks(runHook(`cat ${leakFile} > ${dir}/a.md; cp ${dir}/a.md ${N}; ${G}`)));
  ok('a redirect appended to an existing leaking file still scans the file',
    leaks(runHook(`echo hello >> ${leakFile}; gh issue comment 1 --body-file ${leakFile}`)));
  ok('a source that does not exist and is written by nobody blocks as unreadable',
    code(runHook(`cp ${dir}/nope.md ${N} && ${G}`), 'SECRET_GUARD_UNREADABLE_BODY_FILE'));

  // Not recognised as a writer: keep blocking.
  ok('an unrecognised producer does not excuse a missing file',
    code(runHook(`curl -so ${N} http://x/y; ${G}`), 'SECRET_GUARD_UNREADABLE_BODY_FILE'));
  ok('a write AFTER the gh statement does not count',
    code(runHook(`${G}; echo hello > ${N}`), 'SECRET_GUARD_UNREADABLE_BODY_FILE'));
  ok('a backgrounded writer does not count',
    code(runHook(`echo hello > ${N} & ${G}`), 'SECRET_GUARD_UNREADABLE_BODY_FILE'));
  ok('a different path does not count',
    code(runHook(`echo hello > ${dir}/other.md; ${G}`), 'SECRET_GUARD_UNREADABLE_BODY_FILE'));
  const mk = runHook('f=$(mktemp); echo hi > $f; gh issue comment 1 --body-file $f');
  ok('a $(mktemp) path blocks as unresolved', code(mk, 'SECRET_GUARD_UNRESOLVED_BODY_FILE'));
  ok('the block reasons tell the agent how to proceed',
    /separate Bash call/.test(mk.out) && /mktemp/.test(mk.out) && /heredoc/.test(mk.out));
  ok('the unreadable reason does too', /separate Bash call/.test(runHook(`${G}`).out));

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- end-to-end: expansions inside inline content are scanned (#210 round 2, W5) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210w5-'));
  const leakFile = path.join(dir, 'leak.md');
  const N = path.join(dir, 'new.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const unres = (r) => r.code === 2 && r.out.includes('"code":"SECRET_GUARD_UNRESOLVED_BODY_FILE"');
  const passes = (r) => r.code === 0 && r.out.trim() === '';
  const TOK = { SG_TOK: 'AKIAIOSFODNN7EXAMPLE' };
  const G = 'gh issue comment 1';

  ok('echo "$(cat leak)" | gh -F - blocks', leaks(runHook(`echo "$(cat ${leakFile})" | ${G} -F -`)));
  ok('echo $(cat leak) unquoted | gh -F - blocks', leaks(runHook(`echo $(cat ${leakFile}) | ${G} -F -`)));
  ok('printf "$VAR" | gh -F - scans the env value', leaks(runHook(`printf '%s' "$SG_TOK" | ${G} -F -`, TOK)));
  ok('unquoted heredoc with $(cat leak) blocks', leaks(runHook(`${G} -F - <<EOF\nvalue $(cat ${leakFile})\nEOF`)));
  ok('unquoted heredoc with $VAR blocks', leaks(runHook(`${G} -F - <<EOF\nvalue $SG_TOK\nEOF`, TOK)));
  ok('an apostrophe in the heredoc does not hide a later substitution',
    leaks(runHook(`${G} -F - <<EOF\ndon't $(cat ${leakFile})\nEOF`)));
  ok('herestring "$(cat leak)" blocks', leaks(runHook(`${G} -F - <<< "$(cat ${leakFile})"`)));
  ok('echo "$(cat leak)" > f && gh -F f blocks', leaks(runHook(`echo "$(cat ${leakFile})" > ${N} && ${G} -F ${N}`)));
  ok('heredoc redirect with $(cat leak) then gh blocks',
    leaks(runHook(`cat > ${N} <<EOF\n$(cat ${leakFile})\nEOF\n${G} -F ${N}`)));
  ok('--body "$(cat <<EOF ... $(cat leak) ... EOF)" blocks',
    leaks(runHook(`${G} --body "$(cat <<EOF\nx $(cat ${leakFile}) y\nEOF\n)"`)));
  ok('--body "pre $(cat leak) post" (embedded substitution) blocks', leaks(runHook(`${G} --body "pre $(cat ${leakFile}) post"`)));
  ok('a herestring redirect does not hide the next statement',
    leaks(runHook(`cat > ${N} <<< "x"\n${G} --body-file ${leakFile}`)));

  ok("quoted heredoc <<'EOF' stays literal", passes(runHook(`${G} -F - <<'EOF'\nuse $(cat ${leakFile}) and $SG_TOK\nEOF`, TOK)));
  ok('quoted heredoc <<"EOF" stays literal', passes(runHook(`${G} -F - <<"EOF"\nuse $(cat ${leakFile})\nEOF`)));
  ok('single-quoted echo argument stays literal', passes(runHook(`echo '$(cat ${leakFile})' | ${G} -F -`)));
  ok('unquoted heredoc without expansions passes', passes(runHook(`${G} -F - <<EOF\nplain text, it's fine\nEOF`)));
  ok('echo "$VAR" with a clean env value passes', passes(runHook(`echo "$SG_FINE" | ${G} -F -`, { SG_FINE: 'fine' })));
  ok('an escaped \\$ in an unquoted heredoc is literal', passes(runHook(`${G} -F - <<EOF\ncost \\$SG_UNSET_VAR_210\nEOF`)));

  ok('echo "$(date)" | gh -F - blocks as unresolved', unres(runHook(`echo "$(date)" | ${G} -F -`)));
  ok('echo "$UNSET" | gh -F - blocks as unresolved', unres(runHook(`echo "$SG_UNSET_VAR_210" | ${G} -F -`)));
  ok('unquoted heredoc with $(date) blocks as unresolved', unres(runHook(`${G} -F - <<EOF\n$(date)\nEOF`)));
  ok('herestring "$UNSET" blocks as unresolved', unres(runHook(`${G} -F - <<< "$SG_UNSET_VAR_210"`)));

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- end-to-end: writes inside substitutions are evaluated, not blocked (#210 round 2, W6/W7) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210w6-'));
  const leakFile = path.join(dir, 'leak.md');
  const cleanFile = path.join(dir, 'clean.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  fs.writeFileSync(cleanFile, 'all good\n');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const passes = (r) => r.code === 0 && r.out.trim() === '';
  ok('URL=$(gh issue create ... clean) passes', passes(runHook(`URL=$(gh issue create --title t --body-file ${cleanFile})`)));
  ok('echo "$(gh issue create ... clean)" passes', passes(runHook(`echo "$(gh issue create --title t --body-file ${cleanFile})"`)));
  ok('a backtick substitution with a clean write passes', passes(runHook(`echo \`gh issue create --title t --body-file ${cleanFile}\``)));
  ok('URL=$(gh issue create ... leak) blocks on the body', leaks(runHook(`URL=$(gh issue create --title t --body-file ${leakFile})`)));
  ok('echo "$(gh issue create ... leak)" blocks on the body', leaks(runHook(`echo "$(gh issue create --title t --body-file ${leakFile})"`)));
  ok('a variable set before is visible inside the substitution',
    leaks(runHook(`D=${dir}; X=$(gh issue create --title t --body-file $D/leak.md)`)));
  ok('an unresolvable body inside a substitution still blocks as unresolved',
    runHook('X=$(gh issue create --title t --body-file "$SG_UNSET_VAR_210")').out.includes('SECRET_GUARD_UNRESOLVED_BODY_FILE'));

  // W7: the inline-body block tells the agent how to post literal text.
  const inl = runHook('gh issue comment 1 --body "$(date)"');
  ok('inline body block says to use single quotes or a file',
    inl.code === 2 && /single quotes/.test(inl.out) && /--body-file/.test(inl.out));
  const dollar = runHook('gh issue comment 1 --body "costs $5"');
  ok('a $5 in an inline body gets the inline message', dollar.code === 2 && /single quotes/.test(dollar.out));
  const fileCase = runHook('gh issue comment 1 --body-file "$SG_UNSET_VAR_210/x.md"');
  ok('the body-file block keeps the file message, without the quoting hint',
    fileCase.code === 2 && /separate Bash call/.test(fileCase.out) && !/single quotes/.test(fileCase.out));
  ok('the inline message is distinct from the file message', !/separate Bash call/.test(inl.out));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- THE FAILURE ARM: a scan we could not complete must be OBSERVABLE, not a silent pass ---
const f = runHook('gh issue comment 5 --body "anything"', { TRAILHEAD_SECRETGUARD_THROW: '1' });
ok('could-not-scan does not block (exit 0)', f.code === 0);
ok('could-not-scan is OBSERVABLE, not byte-identical to a clean pass',
  /could NOT complete its scan/.test(f.out) && f.out.trim() !== '');
// And it only fires on an identified write; a read that errors stays silent (nothing to say):
const f2 = runHook('gh issue view 5 --json body', { TRAILHEAD_SECRETGUARD_THROW: '1' });
ok('could-not-scan advisory does NOT fire on a read', f2.code === 0 && f2.out.trim() === '');

console.log(`✓ secret-guard: ${passed} assertions passed`);
