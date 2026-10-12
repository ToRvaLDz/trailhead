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

// --- unit: more wrappers, variable command words, function bodies, case arms (#210 round 2, W4) ---
{
  const kinds = (c) => JSON.stringify(ghWrites(c).map((w) => w.kind));
  const W = 'gh issue comment 1 --body-file /x/b.md';
  const I = '["issue"]';
  ok('write behind sudo', kinds(`sudo ${W}`) === I);
  ok('write behind sudo -u USER -E', kinds(`sudo -u bob -E ${W}`) === I);
  ok('write behind nice / nice -n 5', kinds(`nice ${W}`) === I && kinds(`nice -n 5 ${W}`) === I);
  ok('write behind timeout DURATION / flags', kinds(`timeout 10 ${W}`) === I && kinds(`timeout -k 1 -s KILL 10s ${W}`) === I);
  ok('write behind stdbuf -oL / -o L', kinds(`stdbuf -oL ${W}`) === I && kinds(`stdbuf -o L ${W}`) === I);
  ok('write behind ionice -c 3', kinds(`ionice -c 3 ${W}`) === I);
  ok('wrappers stack', kinds(`sudo nice -n 5 timeout 9 env A=1 ${W}`) === I);
  ok('a wrapper around a read is not a write', kinds('sudo -u bob gh issue list') === '[]');

  ok('variable command word that resolves to gh', kinds(`G=gh; $G issue comment 1 --body-file /x/b.md`) === I);
  ok('quoted and braced variable command word', kinds(`G=gh; "$G" issue comment 1 -F /x/b.md`) === I && kinds(`G=gh; \${G} pr edit 1 -F /x/b.md`) === '["pr"]');
  ok('variable command word resolving to a gh path', kinds(`G=/usr/bin/gh; $G issue comment 1 -F /x/b.md`) === I);
  ok('variable command word resolving to something else is no write', kinds('G=echo; $G issue comment 1') === '[]');
  ok('an unresolvable variable command word with a write verb is opaque', kinds('$SG_UNSET_CMD issue comment 1 --body x') === '["opaque"]');
  ok('an unresolvable variable command word with a read verb is no write', kinds('$SG_UNSET_CMD issue list') === '[]');
  ok('an unresolvable variable command word with no gh words is no write', kinds('$EDITOR file.txt') === '[]');

  ok('write in name(){ ... }', kinds(`post(){ ${W}; }`) === I);
  ok('write in name() { ... }', kinds(`post() { ${W}; }`) === I);
  ok('write in name () { ... }', kinds(`post () { ${W}; }`) === I);
  ok('write in function name { ... }', kinds(`function post { ${W}; }`) === I);
  ok('write in function name() { ... }', kinds(`function post() { ${W}; }`) === I);
  ok('write in a case arm', kinds(`case x in x) ${W};; esac`) === I);
  ok('write in a later case arm and alternation', kinds(`case $a in a|b) true;; c) ${W};; esac`) === I);
  ok('write in a case arm with a leading paren', kinds(`case x in (x) ${W};; esac`) === I);
  ok('case without a write is none', kinds('case x in x) echo hi;; esac') === '[]');
}

// --- end-to-end: wrappers, variable command word, functions, case (#210 round 2, W4) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210w4-'));
  const leakFile = path.join(dir, 'leak.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const W = `gh issue comment 1 --body-file ${leakFile}`;
  ok('sudo gh blocks', leaks(runHook(`sudo -u bob ${W}`)));
  ok('timeout gh blocks', leaks(runHook(`timeout 10 ${W}`)));
  ok('nice -n gh blocks', leaks(runHook(`nice -n 5 ${W}`)));
  ok('$G gh blocks', leaks(runHook(`G=gh; $G issue comment 1 --body-file ${leakFile}`)));
  ok('an unresolvable $CMD with a write verb blocks as opaque',
    runHook('$SG_UNSET_CMD issue comment 1 --body x').out.includes('SECRET_GUARD_OPAQUE_WRITE'));
  ok('a function body blocks', leaks(runHook(`post(){ ${W}; }; post`)));
  ok('function keyword blocks', leaks(runHook(`function post { ${W}; }`)));
  ok('a case arm blocks', leaks(runHook(`case x in x) ${W};; esac`)));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- end-to-end: gh api inline field values are expanded and scanned (#210 round 3, W8) ---
{
  const A = 'gh api repos/o/r/issues/1/comments';
  const SEC = { SEC: 'AKIAIOSFODNN7EXAMPLE' };
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const passes = (r) => r.code === 0 && r.out.trim() === '';
  for (const f of [
    '-f body=$SEC', '-F body=$SEC', '--field body=$SEC', '--raw-field body=$SEC',
    '-f "body=$SEC"', '-fbody=$SEC', '-Fbody=$SEC', '--field=body=$SEC', '--raw-field=body=$SEC', '-f body="$SEC"',
  ]) ok(`api ${f} with a leaking env value blocks`, leaks(runHook(`${A} ${f}`, SEC)));
  ok('api -f body=$SEC with a clean value passes', passes(runHook(`${A} -f body=$SEC`, { SEC: 'fine' })));
  ok("api -f 'body=$SEC' (single quotes) stays literal", passes(runHook(`${A} -f 'body=$SEC'`, SEC)));
  ok('api -f body=$(cat leak) blocks as unresolved text',
    runHook(`${A} -f body="$(date)"`).out.includes('single quotes'));
  ok('api -f body=$UNSET blocks as unresolved', runHook(`${A} -f body=$SG_UNSET_VAR_210`).code === 2);
  ok('api -f title=$SEC (not a body field) is not scanned', passes(runHook(`${A} -f body=hi -f title=$SEC`, SEC)));
  ok('api -f body=@file is literal text for a raw field', passes(runHook(`${A} -f body=@/nonexistent/x.md`)));
  ok('api -F body=@file still reads the file', runHook(`${A} -F body=@/nonexistent/x.md`).out.includes('UNREADABLE_BODY_FILE'));
  ok('api body=$VAR set earlier in the command is expanded', leaks(runHook(`S=${SEC.SEC}; ${A} -f body="x $S"`)));
}

// --- unit: opaque runners only count a gh WRITE in command position (#210 round 3, I5) ---
{
  const kinds = (c) => JSON.stringify(ghWrites(c).map((w) => w.kind));
  const O = '["opaque"]';
  ok('xargs grep "gh issue comment" is not a write', kinds('git ls-files | xargs grep -n "gh issue comment"') === '[]');
  ok("bash -c with --grep='gh pr create' is not a write", kinds(`bash -c "git log --grep='gh pr create'"`) === '[]');
  ok('bash ./x.sh # gh issue comment is not a write', kinds('bash ./x.sh # gh issue comment') === '[]');
  ok('bash -c with the text only quoted in echo is not a write', kinds(`bash -c "echo 'gh issue comment 1'"`) === '[]');
  ok('bash -c with the text only in a comment is not a write', kinds(`bash -c 'gh issue view 3 # gh issue comment 1'`) === '[]');
  ok('a shell heredoc without a write beside a real write is just that write',
    kinds("bash <<'EOF'\nls\nEOF\ngh issue comment 1 --body-file /x/b.md") === '["issue"]');
  ok('a shell heredoc holding a write is opaque', kinds("bash <<'EOF'\ngh issue comment 1 -F /x/b.md\nEOF") === O);
  ok('xargs -I{} gh issue edit is opaque', kinds('echo 1 | xargs -I{} gh issue edit {} --body x') === O);
  ok('xargs -n1 gh issue comment is opaque', kinds('echo 1 | xargs -n1 gh issue comment --body-file /x/b.md') === O);
  ok('xargs gh issue view is not a write', kinds('echo 1 | xargs gh issue view') === '[]');
  ok('xargs sh -c with a write is opaque', kinds(`echo 1 | xargs sh -c 'gh issue comment 1 --body x'`) === O);
  ok('bash -c with a write after && is opaque', kinds('bash -c "ls && gh issue comment 1 --body x"') === O);
  ok('bash -lc with a write is opaque', kinds(`bash -lc 'gh pr create --body x'`) === O);
  ok('eval of a quoted write is opaque', kinds('eval "echo a; gh pr create --body x"') === O);
  ok('eval of a bare write is opaque', kinds('eval gh issue comment 1 --body x') === O);
  ok('bash -c with a gh api body write is opaque', kinds('bash -c "gh api repos/o/r/issues/1/comments -f body=x"') === O);
  ok('bash -c with a nested bash -c write is opaque', kinds(`bash -c "bash -c 'gh issue edit 1 --body x'"`) === O);
}

// --- end-to-end: glued redirects and /dev/null (#210 round 3, I7) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-210i7-'));
  const leakFile = path.join(dir, 'leak.md');
  const C = path.join(dir, 'c.md');
  fs.writeFileSync(leakFile, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  const leaks = (r) => r.code === 2 && /AWS access key/.test(r.out);
  const code = (r, c) => r.code === 2 && r.out.includes(`"code":"${c}"`);
  const passes = (r) => r.code === 0 && r.out.trim() === '';
  const G = `gh issue comment 1 --body-file ${C}`;

  ok('cat >path<<EOF (no spaces) is traced like the spaced form', passes(runHook(`cat >${C}<<'EOF'\nhello\nEOF\n${G}`)));
  ok('cat >path<<EOF with a secret blocks', code(runHook(`cat >${C}<<'EOF'\nAKIAIOSFODNN7EXAMPLE\nEOF\n${G}`), 'SECRET_IN_ISSUE_WRITE'));
  ok('echo x>path (no spaces) is traced', passes(runHook(`echo x>${C} && ${G}`)));
  ok('echo x>>path (no spaces) is traced', passes(runHook(`echo x>>${C} && ${G}`)));
  ok('echo "$(cat leak)">path (no spaces) scans the substitution', leaks(runHook(`echo "$(cat ${leakFile})">${C} && ${G}`)));
  ok('cat leak>path (no spaces) scans the source', leaks(runHook(`cat ${leakFile}>${C}; ${G}`)));
  ok('2>&1 and &>/dev/null stay fd redirects', passes(runHook(`echo hi 2>&1 &>/dev/null; echo ok`)));
  ok('stdin <path glued is read', leaks(runHook(`gh issue comment 1 -F - <${leakFile}`)));

  ok('--body-file /dev/null is an empty body: allowed', passes(runHook('gh issue comment 1 --body-file /dev/null')));
  ok('cat /dev/null | gh -F - is allowed', passes(runHook('cat /dev/null | gh issue comment 1 -F -')));
  ok('-F - < /dev/null is allowed', passes(runHook('gh issue comment 1 -F - < /dev/null')));
  ok('other non-regular files still block as unreadable',
    code(runHook('gh issue comment 1 --body-file /dev/zero'), 'SECRET_GUARD_UNREADABLE_BODY_FILE'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- unit: xargs long value flags (#210 round 4, W9) ---
{
  const kinds = (c) => JSON.stringify(ghWrites(c).map((w) => w.kind));
  const O = '["opaque"]';
  for (const f of ['--max-args 1', '--max-procs 4', '--delimiter X', '--arg-file F', '--max-lines 2', '--eof E', '--max-chars 100', '--process-slot-var V', '--max-args=1', '--replace={}', '-n 1', '-P 4 -n 1', '--null --no-run-if-empty -t']) {
    ok(`xargs ${f} gh issue edit is opaque`, kinds(`echo 1 | xargs ${f} gh issue edit --body hi`) === O);
  }
  ok('xargs --max-args 1 grep "gh issue comment" is allowed', kinds('echo 1 | xargs --max-args 1 grep "gh issue comment"') === '[]');
  ok('xargs --max-procs 4 grep with a bare gh mention in quotes is allowed', kinds(`xargs --max-procs 4 grep -n 'gh pr create'`) === '[]');
  ok('an unknown long xargs flag still fails closed when gh runs later',
    kinds('echo 1 | xargs --future-flag VALUE gh issue edit --body hi') === O);
  ok('an unknown long xargs flag with a harmless command is allowed', kinds('echo 1 | xargs --future-flag VALUE echo hi') === '[]');
}

// --- THE FAILURE ARM: a scan we could not complete must be OBSERVABLE, not a silent pass ---
const f = runHook('gh issue comment 5 --body "anything"', { TRAILHEAD_SECRETGUARD_THROW: '1' });
ok('could-not-scan does not block (exit 0)', f.code === 0);
ok('could-not-scan is OBSERVABLE, not byte-identical to a clean pass',
  /could NOT complete its scan/.test(f.out) && f.out.trim() !== '');
// And it only fires on an identified write; a read that errors stays silent (nothing to say):
const f2 = runHook('gh issue view 5 --json body', { TRAILHEAD_SECRETGUARD_THROW: '1' });
ok('could-not-scan advisory does NOT fire on a read', f2.code === 0 && f2.out.trim() === '');

// --- #212: a phantom << in a fragment must not hide a later opaque heredoc write ---
{
  const hidden = "bash <<'EOF'\ngh issue comment 1 --body hi\nEOF";
  for (const first of ['echo ok', 'echo $((1|2<<3))', 'echo $((1&&2<<3))', 'echo $((1;2<<3))', ': # ;true <<A']) {
    ok(`an opaque heredoc write after ${JSON.stringify(first)} blocks`,
      runHook(`${first}\n${hidden}`).out.includes('SECRET_GUARD_OPAQUE_WRITE'));
  }
}

// --- #215: a token split by a backslash-newline continuation is joined by bash ---
{
  const A = 'ghp_' + 'A1b2C3d4E5f6G7h8';
  const B = 'I9j0K1l2M3n4O5p6Q7r8';
  const BS = '\\'; // one backslash
  const split = A + BS + '\n' + B;
  const blocked = (cmd) => { const r = runHook(cmd); return r.code === 2 && /GitHub token/.test(r.out); };
  const allowed = (cmd) => { const r = runHook(cmd); return r.code === 0 && r.out.trim() === ''; };
  ok('double-quoted --body split by backslash-newline blocks', blocked(`gh issue comment 5 --body "${split}"`));
  ok('unquoted --body split by backslash-newline blocks', blocked(`gh issue comment 5 --body ${split}`));
  ok('single-quoted --body split stays literal and passes', allowed(`gh issue comment 5 --body '${split}'`));
  ok('--title split by backslash-newline blocks', blocked(`gh issue create --title "${split}" --body hi`));
  ok('escaped backslash before the newline is not a continuation', allowed(`gh issue comment 5 --body "${A}${BS}${BS}\n${B}"`));
  const { expandPlain } = require('./lib/body-sources.js');
  ok('expandPlain drops a backslash-newline pair', expandPlain('a' + BS + '\nb $X', {}, { X: 'v' }).value === 'ab v');
  ok('expandPlain keeps an escaped backslash before a newline', expandPlain('a' + BS + BS + '\nb', {}, {}).value === 'a' + BS + '\nb');
  const N = path.join(os.tmpdir(), `sg-215-${process.pid}.md`);
  ok('unquoted heredoc body file with a split token blocks',
    blocked(`cat <<EOF > ${N}\n${split}\nEOF\ngh issue comment 5 --body-file ${N}`));
  ok('unquoted heredoc with $VAR and a split token blocks',
    blocked(`cat <<EOF > ${N}\n$HOME ${split}\nEOF\ngh issue comment 5 --body-file ${N}`));
  ok('quoted heredoc body file with a split token passes',
    allowed(`cat <<'EOF' > ${N}\n${split}\nEOF\ngh issue comment 5 --body-file ${N}`));
}

// --- #217: a token split by adjacent quoted parts is one word for bash ---
{
  const A = 'ghp_' + 'A1b2C3d4E5f6G7h8';
  const B = 'I9j0K1l2M3n4O5p6Q7r8';
  const BS = '\\'; // one backslash
  const blocked = (cmd) => { const r = runHook(cmd); return r.code === 2 && /GitHub token/.test(r.out); };
  const allowed = (cmd) => { const r = runHook(cmd); return r.code === 0 && r.out.trim() === ''; };
  const G = 'gh issue comment 5';
  ok('two adjacent double-quoted parts block', blocked(`${G} --body "${A}""${B}"`));
  ok('a double-quoted part glued to a bare part blocks', blocked(`${G} --body "${A}"${B}`));
  ok('a bare part and an empty single-quote pair block', blocked(`${G} --body ${A}''${B}`));
  ok('bare, continuation, empty quotes block', blocked(`${G} --body ${A}${BS}\n''${B}`));
  ok('quoted, continuation, quoted block', blocked(`${G} --body "${A}"${BS}\n"${B}"`));
  ok('gh api -f body with adjacent quoted parts blocks',
    blocked(`gh api repos/o/r/issues/5/comments -f body="${A}"'${B}'`));
  ok('an echo producer with adjacent quoted parts blocks',
    blocked(`echo "${A}""${B}" | ${G} --body-file -`));
  ok('an unresolvable piece next to split literals is not allowed',
    runHook(`${G} --body "$TRAILHEAD_UNSET_217"${A}''${B}`).code === 2);
  ok('two separate quoted words do not join', allowed(`${G} --body "${A}" "${B}"`));
  ok('-b with a double-quoted and a single-quoted part blocks', blocked(`${G} -b "${A}"'${B}'`));
  ok('--body= with a double-quoted and a single-quoted part blocks', blocked(`${G} --body="${A}"'${B}'`));
  ok('--title with adjacent double-quoted parts blocks', blocked(`gh issue create --title "${A}""${B}" --body hi`));
  ok('a here-string with adjacent quoted parts blocks', blocked(`${G} --body-file - <<<"${A}"'${B}'`));
  ok('a write nested in $(...) with adjacent quoted parts blocks', blocked(`echo $(${G} --body "${A}""${B}")`));
  ok('adjacent ANSI-C quoted parts block', blocked(`${G} --body $'${A}'$'${B}'`));
  ok('adjacent locale-quoted parts block', blocked(`${G} --body $"${A}"$"${B}"`));
  ok('a single-quoted part glued to an ANSI-C part blocks', blocked(`${G} --body '${A}'$'${B}'`));
  ok('an unquoted heredoc keeps quotes literal and passes',
    allowed(`${G} --body-file - <<EOF\n${A}''${B}\nEOF`));
  // A `$` that is escaped or the second char of `$$` does not open an ANSI-C span.
  {
    const dir217 = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-217-'));
    const F = path.join(dir217, 'f1.txt');
    fs.writeFileSync(F, `${A}${B}\n`);
    const C = 'gh issue create --title';
    ok('an escaped dollar before a quote keeps later flags visible',
      blocked(`${C} ${BS}$'x${BS}' --body-file ${F} --label 'z'`));
    ok('a doubled dollar before a quote keeps later flags visible',
      blocked(`${C} $$'x${BS}' --body-file ${F} --label 'z'`));
    ok('an escaped dollar before a quote at the end still reads the file',
      blocked(`${C} ${BS}$'x${BS}' --body-file ${F}`));
    // A fake ANSI-C span after `$$` must not hide a later write (`$$'x\'` is PID + 'x\').
    const W = `gh issue comment 1 --body-file ${F}`;
    const Wq = `gh issue comment 1 --body '${A}''${B}'`;
    ok('a doubled dollar before a quote does not hide a later --body-file write',
      blocked(`echo $$'x${BS}' ; ${W} # '`));
    ok('a doubled dollar before a quote does not hide a later split-quote write',
      blocked(`echo $$'x${BS}' ; ${Wq} # '`));
    ok('an escaped dollar before a quote does not hide a later write',
      blocked(`echo ${BS}$'x${BS}' ; ${W} # '`));
    // The bare-dollar state survives a backslash-newline continuation.
    ok('a continued doubled dollar does not hide a later --body-file write',
      blocked(`echo $${BS}\n$'x${BS}' ; ${W} ; echo ''`));
    ok('a continued doubled dollar does not hide a later split-quote write',
      blocked(`echo $${BS}\n$'x${BS}' ; ${Wq} ; echo ''`));
    // `$${` / `$$[` are the PID plus a literal char, so the write between them runs.
    ok('a doubled dollar before a brace does not hide a later write',
      blocked(`echo $${'${'} ; ${W} ; echo }`));
    ok('a doubled dollar before a bracket does not hide a later write',
      blocked(`echo $$[ ; ${W} ; echo ]`));
    ok('a continued dollar before a brace does not hide a later write',
      blocked(`echo $${BS}\n${'${'} ; ${W} ; echo }`));
    {
      const { words } = require('./lib/body-sources.js');
      const J = JSON.stringify;
      ok('words: a continued doubled dollar leaves the quote plain',
        J(words(`echo $${BS}\n$'x${BS}' y'`)) === J(['echo', `$$'x${BS}'`, "y'"]));
      ok('words: a continued dollar then a quote opens ANSI-C',
        J(words(`echo $${BS}\n'x${BS}' y'`)) === J(['echo', `$'x${BS}' y'`]));
    }
    fs.rmSync(dir217, { recursive: true, force: true });
  }
}

// --- #219: a quoted or split command word or field key is the same word for bash ---
{
  const T = 'ghp_' + 'A'.repeat(36);
  const BS = '\\'; // one backslash
  const blocked = (cmd) => { const r = runHook(cmd); return r.code === 2 && /GitHub token/.test(r.out); };
  const allowed = (cmd) => { const r = runHook(cmd); return r.code === 0 && r.out.trim() === ''; };
  const opaque = (cmd) => { const r = runHook(cmd); return r.code === 2 && /SECRET_GUARD_OPAQUE_WRITE/.test(r.out); };
  ok('a double-quoted gh command word blocks', blocked(`"gh" issue comment 5 --body ${T}`));
  ok('a quoted subcommand blocks', blocked(`gh 'issue' comment 5 --body ${T}`));
  ok('a split verb blocks', blocked(`gh issue com""ment 5 --body ${T}`));
  ok('a quoted gh api field key blocks', blocked(`gh api repos/o/r/issues/5/comments -f 'body'=${T}`));
  ok('a double-quoted gh api field key blocks', blocked(`gh api repos/o/r/issues/5/comments -f "body"=${T}`));
  ok('a split gh api field key blocks', blocked(`gh api repos/o/r/issues/5/comments -f bo""dy=${T}`));
  ok('a backslash-escaped command word blocks', blocked(`${BS}gh issue comment 5 --body ${T}`));
  ok('a backslash-escaped subcommand blocks', blocked(`gh is${BS}sue comment 5 --body ${T}`));
  ok('an ANSI-C quoted command word blocks', blocked(`$'gh' issue comment 5 --body ${T}`));
  ok('a split command word blocks', blocked(`g"h" issue comment 5 --body ${T}`));
  ok('a quoted path to gh blocks', blocked(`"/usr/bin/gh" issue comment 5 --body ${T}`));
  ok('a quoted pr verb blocks', blocked(`gh pr 'edit' 5 --body ${T}`));
  ok('a quoted gh behind a compound separator blocks', blocked(`cd /tmp && "gh" issue comment 5 --body ${T}`));
  // A quoted shell runner or wrapper is the same command for bash: opaque like the bare form.
  ok('the unquoted bash -c form is opaque (control)', opaque('bash -c "gh issue comment 5 --body x"'));
  ok('a quoted bash runner is opaque', opaque(`'bash' -c "gh issue comment 5 --body x"`));
  ok('a quoted env wrapper and bash runner are opaque', opaque(`"env" "bash" -c "gh issue comment 5 --body x"`));
  ok('a quoted env wrapper in front of a quoted gh blocks', blocked(`"env" "gh" issue comment 5 --body ${T}`));
  // A variable command word we cannot resolve falls back to the write words, quote-removed.
  ok('an unresolved command word with a quoted subcommand is opaque',
    opaque("$TRAILHEAD_UNSET_219 'issue' comment 5 --body x"));
  ok('an unresolved command word with a split verb is opaque',
    opaque('$TRAILHEAD_UNSET_219 issue com""ment 5 --body x'));
  // A body file behind a quoted or split body= key is still read.
  {
    const dir219 = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-219-'));
    const F = path.join(dir219, 'body.txt');
    fs.writeFileSync(F, `${T}\n`);
    ok("gh api -F 'body'=@file reads the file", blocked(`gh api x -F 'body'=@${F}`));
    ok('gh api -F "body"=@file reads the file', blocked(`gh api x -F "body"=@${F}`));
    ok('gh api -F bo""dy=@file reads the file', blocked(`gh api x -F bo""dy=@${F}`));
    ok('gh api -F body=@file reads the file (control)', blocked(`gh api x -F body=@${F}`));
    ok("gh api -f 'body'=@file keeps @ literal and passes", allowed(`gh api x -f 'body'=@${F}`));
    fs.rmSync(dir219, { recursive: true, force: true });
  }
  // Negative controls: not a tracker write, or nothing to flag.
  ok('a quoted read-only subcommand passes', allowed(`gh 'issue' view 5 --json body`));
  ok('gh issue list passes', allowed('gh issue list'));
  ok('a quoted gh issue list passes', allowed('"gh" "issue" list'));
  ok('gh inside an echo string argument passes', allowed('echo "gh issue comment"'));
  ok('a quoted bash running a non-write passes', allowed("'bash' -c \"echo hi\""));
  ok('a clean body through a quoted command word passes', allowed('"gh" issue comment 5 --body hello'));
  // A quoted flag name is the same flag: --input, wrapper flags, body-file flags.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-219b-'));
    const F = path.join(dir, 'body.txt');
    fs.writeFileSync(F, `${T}\n`);
    ok('gh api --input file blocks (control)', blocked(`gh api x --input ${F}`));
    ok("gh api '--input' file blocks", blocked(`gh api x '--input' ${F}`));
    ok('gh api --inp""ut file blocks', blocked(`gh api x --inp""ut ${F}`));
    ok('a quoted gh and a quoted --input block', blocked(`"gh" api x "--input" ${F}`));
    ok('env "-i" in front of gh blocks', blocked(`env "-i" gh issue comment 5 --body ${T}`));
    ok('sudo "-u" root in front of gh blocks', blocked(`sudo "-u" root gh issue comment 5 --body ${T}`));
    ok('nice "-n" 5 in front of gh blocks', blocked(`nice "-n" 5 gh issue comment 5 --body ${T}`));
    ok("env '-u' X in front of gh blocks", blocked(`env '-u' X gh issue comment 5 --body ${T}`));
    ok('env -u X in front of gh blocks (control)', blocked(`env -u X gh issue comment 5 --body ${T}`));
    const G = 'gh issue comment 5';
    ok('--body-file F blocks (control)', blocked(`${G} --body-file ${F}`));
    ok("'-F' F blocks", blocked(`${G} '-F' ${F}`));
    ok('"--body-file" F blocks', blocked(`${G} "--body-file" ${F}`));
    ok('--body-fi""le F blocks', blocked(`${G} --body-fi""le ${F}`));
    ok('"--body-file=F" blocks', blocked(`${G} "--body-file=${F}"`));
    ok("'--body' T blocks", blocked(`${G} '--body' ${T}`));
    ok("gh api '--field' body=@F blocks", blocked(`gh api x '--field' body=@${F}`));
    ok("gh api '-F' body=@F blocks", blocked(`gh api x '-F' body=@${F}`));
    ok('a quoted unrelated flag does not read the file', allowed(`${G} '--label' ${F} --body hi`));
    // A quoted free-text VALUE that looks like a flag is a value, not a flag.
    ok('a title that starts with a flag-like word passes', allowed('gh issue create --title "-F handling" --body hi'));
    ok('a body that starts with a flag-like word passes', allowed('gh issue create --title "Fix thing" --body "-F is a flag"'));
    // A quoted value equal to a body-file flag is read as the flag, erring toward detection
    // (the unquoted form already did): a flag arity table without subcommand awareness is unsafe.
    ok('a --body value equal to --body-file=x is read as the flag', runHook(`${G} --body '--body-file=x'`).code === 2);
    ok('a -b value equal to -F is read as the flag', runHook(`${G} -b '-F' x`).code === 2);
    // A quoted ATTACHED short form (`-Fpath`) is the same flag.
    ok('attached -F"path" blocks (control)', blocked(`${G} -F"${F}"`));
    ok('a fully double-quoted attached -Fpath blocks', blocked(`${G} "-F${F}"`));
    ok('a fully single-quoted attached -Fpath blocks', blocked(`${G} '-F${F}'`));
    ok('a quoted letter in an attached -Fpath blocks', blocked(`${G} -"F"${F}`));
    ok('a quoted letter and value in an attached -Fpath blocks', blocked(`${G} -"F${F}"`));
    ok('a quoted flag glued to its value blocks', blocked(`${G} "-F"${F}`));
    // A quoted no-whitespace value that starts like the flag is read as the flag, erring toward detection.
    ok('a title like "-Fixes" is read as an attached -F', runHook(`gh issue create --title "-Fixes" --body hi`).code === 2);
    // A quoted attached value with whitespace in a span of its own is still the flag's value.
    {
      const dirSp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-219 sp-'));
      const FS = path.join(dirSp, 'my body.txt');
      fs.writeFileSync(FS, `${T}\n`);
      ok('-"F"/"p a" blocks', blocked(`${G} -"F"${'"'}${FS}${'"'}`));
      ok('"-F"/"p a" blocks', blocked(`${G} "-F""${FS}"`));
      ok("-'F'\"/p a\" blocks", blocked(`${G} -'F'"${FS}"`));
      ok('-F"/p a" blocks (control)', blocked(`${G} -F"${FS}"`));
      ok('"-F handling" with a space in the flag span still passes', allowed(`${G} --title "-F ${FS}" --body hi`));
      // A whole-token quoted attached flag keeps its spaced path: only a space DIRECTLY after the letter is text.
      ok('"-F<path with space>" blocks', blocked(`${G} "-F${FS}"`));
      ok("'-F<path with space>' blocks", blocked(`${G} '-F${FS}'`));
      ok('-"F<path with space>" blocks', blocked(`${G} -"F${FS}"`));
      ok('"-F x" is still free text', allowed(`${G} --title "-F x" --body hi`));
      fs.rmSync(dirSp, { recursive: true, force: true });
    }
    // -r and -a are boolean in `gh pr review`: the -F after them is still the body file.
    ok('gh pr review -r -F file blocks', blocked(`gh pr review 5 -r -F ${F}`));
    ok('gh pr review -a -F file blocks', blocked(`gh pr review 5 -a -F ${F}`));
    ok('gh pr review -c -F file blocks', blocked(`gh pr review 5 -c -F ${F}`));
    // ANSI-C escapes in a word are decoded by bash.
    ok('a hex-escaped command word blocks', blocked(`$'\\x67h' issue comment 5 --body ${T}`));
    ok('a hex-escaped verb blocks', blocked(`gh issue $'comm\\x65nt' 5 --body ${T}`));
    ok('an octal-escaped subcommand blocks', blocked(`gh $'\\151ssue' comment 5 --body ${T}`));
    ok('a unicode-escaped command word blocks', blocked(`$'\\u0067h' issue comment 5 --body ${T}`));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- #220: a token rebuilt by brace expansion ---
{
  const A = 'ghp_' + 'A1b2C3d4E5f6G7h8';
  const B = 'I9j0K1l2M3n4O5p6Q7r8';
  const BS = '\\'; // one backslash
  const blocked = (cmd, env) => { const r = runHook(cmd, env); return r.code === 2 && /GitHub token/.test(r.out); };
  const allowed = (cmd) => { const r = runHook(cmd); return r.code === 0 && r.out.trim() === ''; };
  const G = 'gh issue comment 5';
  ok('an empty first alternative rebuilds the token', blocked(`${G} --body ${A}{,x}${B}`));
  ok('quoted halves around a brace group rebuild the token', blocked(`${G} --body "${A}"{,x}"${B}"`));
  ok('an empty last alternative rebuilds the token', blocked(`${G} --body ${A}{x,}${B}`));
  ok('a token inside an alternative rebuilds', blocked(`${G} --body :{${A},y}${B}`));
  ok('gh api -f body with a brace group blocks',
    blocked(`gh api repos/o/r/issues/5/comments -f body=${A}{,x}${B}`));
  ok('--title with a brace group blocks', blocked(`gh issue create --title ${A}{,x}${B} --body hi`));
  ok('an echo producer with a brace group blocks', blocked(`echo ${A}{,x}${B} | ${G} --body-file -`));
  ok('a nested brace group blocks', blocked(`${G} --body ${A}{x,{,y}}${B}`));
  {
    const A16 = 'ghp_' + 'A1b2C3d4E5f6G7h8';
    const B19 = 'I9j0K1l2M3n4O5p6Q7r';
    ok('a letter sequence rebuilds the token', blocked(`${G} --body ${A16}{Z..Z}${B19}`));
  }
  ok('$VAR halves around a brace group block',
    blocked(`${G} --body "$P"{,x}"$Q"`, { P: A, Q: B }));
  // Quoted or escaped braces are literal.
  ok('a double-quoted brace group passes', allowed(`${G} --body "${A}{,x}${B}"`));
  ok('a single-quoted brace group passes', allowed(`${G} --body '${A}{,x}${B}'`));
  ok('an escaped brace group passes', allowed(`${G} --body ${A}${BS}{,x${BS}}${B}`));
  ok('{x} without a comma passes', allowed(`${G} --body ${A}{x}${B}`));
  ok('{} passes', allowed(`${G} --body ${A}{}${B}`));
  ok('an unquoted heredoc is not brace-expanded', allowed(`${G} --body-file - <<EOF\n${A}{,x}${B}\nEOF`));
  // Too many results: fail closed.
  ok('a brace product over the limit fails closed',
    runHook(`${G} --body ${'{a,b}'.repeat(9)}`).code === 2);
  ok('a huge sequence fails closed', runHook(`${G} --body {1..999999999}`).code === 2);
  ok('a small brace group of clean text passes', allowed(`${G} --body {a,b}`));
  // Signed sequences, as bash reads them.
  ok('a +0..0 sequence rebuilds the token', blocked(`${G} --body ${A}{+0..0}${B}`));
  ok('a 0..+0 sequence rebuilds the token', blocked(`${G} --body ${A}{0..+0}${B}`));
  ok('a signed step sequence rebuilds the token', blocked(`${G} --body ${A}{1..+1..+1}${B}`));
  ok('a -0..0 sequence still lists its values', blocked(`${G} --body ${A}{0..-0}${B}`));
  // Deep nesting is a decoy word or a body: fail closed, never a crash or a skipped scan.
  {
    const deep = '{x,'.repeat(5000) + 'y' + '}'.repeat(5000);
    ok('a deeply nested decoy word does not hide a rebuilt token', runHook(`${G} --body ${A}{,x}${B} ${deep}`).code === 2);
    ok('a deeply nested body fails closed', runHook(`${G} --body ${deep}`).code === 2);
    ok('a deeply nested ${ body fails closed', runHook(`${G} --body ${'${a'.repeat(5000)}`).code === 2);
  }
  // Brace groups in the command, subcommand or verb word.
  ok('a brace group in the subcommand blocks', runHook(`gh {issue,issue} comment 5 --body ${A}${B}`).code === 2);
  ok('a brace group in the command word blocks', runHook(`{gh,gh} issue comment 5 --body ${A}${B}`).code === 2);
  ok('a brace group in the verb blocks', runHook(`gh issue {comment,comment} 5 --body ${A}${B}`).code === 2);
  ok('a brace group that builds only one write verb blocks', runHook(`gh issue {view,comment} 5 --body ${A}${B}`).code === 2);
  ok('a brace group in a read-only verb passes', allowed('gh issue {view,list} 5'));
  // Brace groups anywhere in the gh argument list: flag names, field keys, global flags.
  {
    const T = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const API = 'gh api repos/o/r/issues/5/comments';
    ok('a brace group in a field key blocks', blocked(`${API} -f b{ody,ody}=${T}`));
    ok('a brace group in a short flag blocks', blocked(`${API} -{f,f} body=${T}`));
    ok('a brace group in a long flag blocks', blocked(`${API} --{field,field} body=${T}`));
    ok('an empty-alternative group after the key blocks', blocked(`${API} -f body{,}=${T}`));
    ok('a token split by a group in a field key blocks', blocked(`${API} -f b{ody,ody}=${A}{,x}${B}`));
    ok('a gh global flag before a braced subcommand blocks', runHook(`gh -R o/r {issue,issue} comment 5 --body ${T}`).code === 2);
    ok('gh --repo before a braced subcommand blocks', runHook(`gh --repo o/r {issue,issue} comment 5 --body ${T}`).code === 2);
    ok('a read-only braced verb passes', allowed('gh issue {view,list} 5'));
    ok('a read-only braced subcommand passes', allowed('gh pr {view,diff} 5'));
    ok('a braced gh command word on a read passes', allowed('{gh,gh} issue view 5'));
    ok('a braced --label with a clean body passes', allowed(`${G} --label {a,b} --body hello`));
  }
  // Only a gh WORD makes a braced statement a candidate write; an overflow only blocks a write-shaped one.
  {
    const T = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    ok('"gh" inside another word is not a gh command (echo)', allowed('echo {a..z}{a..z}{a..z} high'));
    ok('"gh" inside a path is not a gh command (cp)', allowed('cp f{1..1000} ~/highway/'));
    ok('"gh" inside a quoted arg is not a gh command (npm)',
      allowed(`npm run test -- --grep "right" ${'{a,b}'.repeat(9)}`));
    ok('a read-only gh command with an oversized group passes', allowed('gh issue view {1..300}'));
    ok('a read-only gh list with nine groups passes', allowed(`gh issue list ${'{a,b}'.repeat(9)}`));
    ok('a gh comment with an oversized group blocks', runHook(`${G} --body hi {1..300}`).code === 2);
    ok('a gh api body with nine groups blocks', runHook(`gh api x -f body=hi ${'{a,b}'.repeat(9)}`).code === 2);
    ok('a braced gh command word still blocks', runHook(`{gh,gh} issue comment 5 --body ${T}`).code === 2);
    ok('a split braced gh command word still blocks', runHook(`g{h,h} issue comment 5 --body ${T}`).code === 2);
  }
  {
    const { braceExpand } = require('./lib/body-sources.js');
    const J = JSON.stringify;
    const w = (s) => J(braceExpand(s).words);
    ok('braceExpand: comma list', w('a{b,c}d') === J(['abd', 'acd']));
    ok('braceExpand: empty alternative', w('a{,x}b') === J(['ab', 'axb']));
    ok('braceExpand: nested', w('{x,{,y}}') === J(['x', '', 'y']));
    ok('braceExpand: numeric sequence', w('{1..3}') === J(['1', '2', '3']));
    ok('braceExpand: descending sequence with step', w('{5..1..2}') === J(['5', '3', '1']));
    ok('braceExpand: letter sequence', w('{a..c}') === J(['a', 'b', 'c']));
    ok('braceExpand: cartesian product', w('{a,b}{1,2}') === J(['a1', 'a2', 'b1', 'b2']));
    ok('braceExpand: ${HOME} is untouched', w('${HOME}') === J(['${HOME}']));
    ok('braceExpand: a quoted comma is not a group', w('"{a,b}"') === J(['"{a,b}"']));
    ok('braceExpand: an escaped brace is not a group', w('\\{a,b}') === J(['\\{a,b}']));
    ok('braceExpand: {x} and {} are literal', w('{x}{}') === J(['{x}{}']));
    ok('braceExpand: quotes are kept', w('"a"{b,c}') === J(['"a"b', '"a"c']));
    ok('braceExpand: a +0 sequence', w('a{+0..0}b') === J(['a0b']));
    ok('braceExpand: a signed step', w('{1..+3..+1}') === J(['1', '2', '3']));
    ok('braceExpand: padding counts the sign', w('{-01..2}') === J(['-01', '000', '001', '002']));
    ok('braceExpand: padding of a negative range', w('{-5..-01}') === J(['-05', '-04', '-03', '-02', '-01']));
    ok('braceExpand: padding down through zero', w('{01..-3}') === J(['01', '00', '-1', '-2', '-3']));
    ok('braceExpand: -0 is not padded', w('{-0..2}') === J(['0', '1', '2']));
    ok('braceExpand: a $(...) span is not split', w('$(echo {a,b})x') === J(['$(echo {a,b})x']));
    ok('braceExpand: a backtick span is not split', w('`echo {a,b}`') === J(['`echo {a,b}`']));
    ok('braceExpand: deep nesting overflows', braceExpand('{x,'.repeat(5000) + 'y' + '}'.repeat(5000)).overflow === true);
    ok('braceExpand: deep ${ overflows', braceExpand('${a'.repeat(5000)).overflow === true);
    ok('braceExpand: many unmatched braces stay fast', (() => { const t = Date.now(); braceExpand('{'.repeat(100000)); return Date.now() - t < 5000; })());
    ok('braceExpand: overflow is not a fault', braceExpand('{a,b}'.repeat(9)).fault !== true);
    ok('braceExpand: deep nesting is a size overflow, not a fault', braceExpand('{x,'.repeat(5000) + 'y' + '}'.repeat(5000)).fault !== true);
    ok('braceExpand: overflow', braceExpand('{a,b}'.repeat(9)).overflow === true);
    ok('braceExpand: a huge sequence overflows', braceExpand('{1..999999999}').overflow === true);
    ok('braceExpand: the limit is a parameter', braceExpand('{a,b,c}', 2).overflow === true);
  }
}

// #225: a flag between the subcommand and the verb must not hide the write.
{
  const T = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'.slice(0, 36);
  for (const c of [
    `gh issue -R o/r comment 5 --body ${T}`,
    `gh pr -R o/r comment 5 --body ${T}`,
    `gh issue --repo o/r comment 5 --body ${T}`,
    `gh issue --repo=o/r comment 5 --body ${T}`,
  ]) {
    const r = runHook(c);
    ok(`blocks a secret with a flag before the verb: ${c.slice(0, 40)} (exit 2)`, r.code === 2 && /"decision":"block"/.test(r.out));
  }
  ok('allows gh issue -R o/r view 5', runHook('gh issue -R o/r view 5').code === 0);
}

// --- #227: constructs the guard cannot interpret are blocked, not emulated ---
{
  const CODE = 'SECRET_GUARD_UNMODELLED_CONSTRUCT';
  const clean = path.join(os.tmpdir(), `sg-um-clean-${process.pid}.md`);
  const dirty = path.join(os.tmpdir(), `sg-um-dirty-${process.pid}.md`);
  fs.writeFileSync(clean, 'All good, 12 tests green.\n');
  fs.writeFileSync(dirty, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  const T = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'.slice(0, 36);
  const code = (c, env) => { const r = runHook(c, env); return r.code === 2 ? (JSON.parse(r.out).code || '?') : null; };
  const msg = (c) => { const r = runHook(c); return r.code === 2 ? JSON.parse(r.out).reason : ''; };

  // Gaps that used to pass: the write hides behind a construct.
  for (const c of [
    `echo \${ gh issue comment 1 --body-file ${dirty}; }`,
    `echo \${ gh issue comment 1 --body-file ${clean}; }`,
    `echo \${| gh issue comment 1 --body x; }`,
    'alias g=gh; g issue comment 1 --body x',
    `source ./post.sh; gh issue comment 1 --body-file ~/${path.basename(clean)}`, // HOME is the tmp dir below
    `. ./post.sh && gh issue comment 1 --body-file ~/${path.basename(clean)}`,
    `f() { gh issue comment 1 --body-file ${clean}; }; f`,
    `function f { gh issue comment 1 --body x; }\nf`,
    `gh issue com\\\nment 1 --body-file ${clean}`,
  ]) ok(`blocks an unmodelled construct: ${c.slice(0, 50).replace(/\n/g, ' ')}`, code(c, { HOME: os.tmpdir() }) === CODE);

  // Existing verdicts keep priority over the new gate.
  ok('eval + gh write stays an opaque-write block', code(`eval 'gh issue comment 1 --body-file ${clean}'`) === 'SECRET_GUARD_OPAQUE_WRITE');
  ok('a function body with a literal secret stays a secret block', code(`f() { gh issue comment 1 --body ${T}; }; f`) === 'SECRET_IN_ISSUE_WRITE');
  ok('a secret file next to source stays a secret block', code(`source ./x.sh; gh issue comment 1 --body-file ${dirty}`) === 'SECRET_IN_ISSUE_WRITE');
  ok('an unreadable body file next to source keeps its code', code('source ./x.sh; gh issue comment 1 --body-file /nonexistent/sg-um.md') === 'SECRET_GUARD_UNREADABLE_BODY_FILE');
  ok('printf -v feeding a body still blocks (unresolved)', code('printf -v B %s x; gh issue edit 1 --body "$B"') !== null);
  ok('the gate also replaces the could-not-scan advisory', code(`source ./x.sh; gh issue comment 1 --body-file ~/${path.basename(clean)}`, { TRAILHEAD_SECRETGUARD_THROW: '1', HOME: os.tmpdir() }) === CODE);

  // Plain controls pass.
  for (const c of [
    "alias ll='ls -l'",
    'alias g=gh',
    "alias ll='ls -l'; gh issue comment 1 --body-file " + clean,
    'alias g=gh; g issue list',
    'source ~/.venv/bin/activate && pytest',
    'eval "$(ssh-agent)"',
    'eval "$(ssh-agent)"; gh issue comment 1 --body-file ' + clean,
    'printf -v x %s y; echo $x',
    'f() { gh issue comment 1 --body x; }',
    'f() { ls; }; gh issue comment 1 --body-file ' + clean,
    `echo \${ date; }; gh issue comment 1 --body-file ${clean}`,
    `gh issue comment 1 --body-file ${clean}; source ./post.sh`,
    `. venv/bin/activate && gh issue edit 1 --body 'hello'`,
    `source venv/bin/activate && gh issue comment 1 --body-file ${clean}`,
    `gh issue comment 1 --body-file ${clean}; printf -v x %s y`,
    `gh issue comment 1 --body 'use eval and source and alias here'`,
    `gh issue comment 1 --body-file ${clean} # eval x`,
    'echo "gh issue edit 1"; alias ll=ls',
    `gh issue comment 1 \\\n  --body-file ${clean}`,
    `gh api repos/o/r/issues/1/comments -f body=x`,
    `gh api repos/o/r/issues/1/comments -f 'body'=x`, // followed exactly since #219
    `gh api repos/o/r/issues/1/comments -f bo""dy=x`,
    `gh api repos/o/r/issues/1/comments -f "body=x"`,
    `gh api repos/o/r/issues/1/comments -F title=x`,
  ]) ok(`passes a plain form: ${c.slice(0, 50).replace(/\n/g, ' ')}`, runHook(c).code === 0);

  const m = msg(`echo \${ gh issue comment 1 --body ${T}; }`);
  ok('the message explains the rewrite', /cannot interpret with certainty/.test(m) && /Rewrite it in a simple form/.test(m));
  ok('the message never echoes the token', m !== '' && !m.includes(T) && !m.includes('ghp_'));

  // Regression (#226): a variable-held directory resolves; clean passes, secret and missing block.
  const dir = path.join(os.tmpdir(), `sg-um-dir-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.md'), 'All good.\n');
  ok('S=<dir>; --body-file $S/x.md passes on a clean file', runHook(`S=${dir}; gh issue edit 13 --body-file $S/x.md`).code === 0);
  fs.writeFileSync(path.join(dir, 'x.md'), 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  ok('S=<dir>; --body-file $S/x.md blocks on a secret file', code(`S=${dir}; gh issue edit 13 --body-file $S/x.md`) === 'SECRET_IN_ISSUE_WRITE');
  fs.rmSync(path.join(dir, 'x.md'));
  ok('S=<dir>; --body-file $S/x.md blocks when the file is missing', code(`S=${dir}; gh issue edit 13 --body-file $S/x.md`) === 'SECRET_GUARD_UNREADABLE_BODY_FILE');
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(clean);
  fs.rmSync(dirty);
}

console.log(`✓ secret-guard: ${passed} assertions passed`);
