#!/usr/bin/env node
// Tests for trailhead-body-guard.js. Run: node trailhead-body-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK = path.join(__dirname, 'trailhead-body-guard.js');
const { ghBodyWrite, isEmptyBody } = require('./trailhead-body-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Run the hook end-to-end: pipe tool_input JSON on stdin, capture {code, out}.
function runHook(command, env = {}) {
  const input = JSON.stringify({ tool_input: { command } });
  try {
    const out = execFileSync('node', [HOOK], { input, env: { ...process.env, ...env } });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}

// --- unit: ghBodyWrite() recognition ---
{
  const tmp = path.join(os.tmpdir(), `bg-file-${process.pid}.md`);
  fs.writeFileSync(tmp, 'hello there\n');
  const r1 = ghBodyWrite(`gh issue edit 5 --body-file ${tmp}`);
  ok('recognizes gh issue edit --body-file', r1 && r1.kind === 'issue' && r1.body === 'hello there\n');
  fs.unlinkSync(tmp);
}
ok('recognizes gh issue edit --body (inline)',
  (() => { const r = ghBodyWrite('gh issue edit 5 --body "hi"'); return r && r.kind === 'issue' && r.body === 'hi'; })());
ok('recognizes gh pr edit --body "" (empty inline)',
  (() => { const r = ghBodyWrite('gh pr edit 5 --body ""'); return r && r.kind === 'pr' && r.body === ''; })());
ok('recognizes gh api ... -f body=foo',
  (() => { const r = ghBodyWrite('gh api --method PATCH repos/o/r/issues/5 -f body=foo'); return r && r.kind === 'api' && r.body === 'foo'; })());
ok('recognizes the -R o/r global-flag form',
  (() => { const r = ghBodyWrite('gh -R owner/repo issue edit 5 --body "hi"'); return r && r.kind === 'issue' && r.body === 'hi'; })());
// Regression (#153): an unknown two-token global flag (e.g. --hostname h)
// before the subcommand must not desync the walk and hide the write.
ok('recognizes gh issue edit behind an unknown two-token global flag (--hostname h)',
  (() => { const r = ghBodyWrite('gh --hostname h issue edit 5 --body ""'); return r && r.kind === 'issue' && r.body === ''; })());
ok('recognizes gh pr edit behind an unknown two-token global flag (--hostname h)',
  (() => { const r = ghBodyWrite('gh --hostname h pr edit 5 --body ""'); return r && r.kind === 'pr' && r.body === ''; })());
// Regression (#153 follow-up): a two-token global flag whose VALUE literally
// equals a subcommand keyword (`api`) must still resolve the real `issue
// edit` write.
ok('recognizes gh issue edit behind a keyword-valued two-token global flag (--hostname api)',
  (() => { const r = ghBodyWrite('gh --hostname api issue edit 5 --body ""'); return r && r.kind === 'issue' && r.body === ''; })());

// --- unit: ghBodyWrite() non-matches ---
ok('ignores gh issue edit with no body param',
  ghBodyWrite('gh issue edit 5 --add-label x') === null);
ok('ignores gh issue comment (excluded verb)',
  ghBodyWrite('gh issue comment 5 --body "hi"') === null);
ok('ignores gh issue create (excluded verb)',
  ghBodyWrite('gh issue create --title t --body-file /tmp/x') === null);
ok('ignores non-gh commands',
  ghBodyWrite('echo --body ""') === null);

// --- unit: unknowable bodies are not blockable ---
{
  const r = ghBodyWrite('gh issue edit 5 --body "$(cat f)"');
  ok('a shell-expansion inline body is unknowable (not blockable)', r && r.kind === 'issue' && r.body === null);
}
{
  const r = ghBodyWrite('gh issue edit 5 --body-file -');
  ok('a --body-file - (stdin) body is unknowable (not blockable)', r && r.kind === 'issue' && r.body === null);
}
{
  const r = ghBodyWrite('gh issue edit 5 --body-file /no/such/file/does-not-exist.md');
  ok('a --body-file whose read throws is unknowable (not blockable)', r && r.kind === 'issue' && r.body === null);
}

// --- unit: isEmptyBody() ---
ok("isEmptyBody('') is true", isEmptyBody('') === true);
ok("isEmptyBody('   \\n\\t ') is true", isEmptyBody('   \n\t ') === true);
ok("isEmptyBody('x') is false", isEmptyBody('x') === false);
ok("isEmptyBody(' a ') is false", isEmptyBody(' a ') === false);

// --- end-to-end: block ---
const b1 = runHook('gh issue edit 5 --body ""');
ok('blocks an empty inline --body (exit 2)', b1.code === 2 && /"decision":"block"/.test(b1.out) && /EMPTY_ISSUE_BODY_WRITE/.test(b1.out));

// Regression (#153): the same block must fire when an unknown two-token
// global flag (e.g. --hostname h) sits before the subcommand.
const bHost1 = runHook('gh --hostname h issue edit 5 --body ""');
ok('blocks an empty --body behind an unknown two-token global flag (issue edit, exit 2)',
  bHost1.code === 2 && /"decision":"block"/.test(bHost1.out) && /EMPTY_ISSUE_BODY_WRITE/.test(bHost1.out));
const bHost2 = runHook('gh --hostname h pr edit 5 --body ""');
ok('blocks an empty --body behind an unknown two-token global flag (pr edit, exit 2)',
  bHost2.code === 2 && /"decision":"block"/.test(bHost2.out) && /EMPTY_ISSUE_BODY_WRITE/.test(bHost2.out));

// Regression (#153 follow-up): a two-token global flag whose VALUE literally
// equals a subcommand keyword (`api`) must still block the real `issue edit`
// empty-body write end to end.
const bHost3 = runHook('gh --hostname api issue edit 5 --body ""');
ok('blocks an empty --body behind a keyword-valued two-token global flag (--hostname api, exit 2)',
  bHost3.code === 2 && /"decision":"block"/.test(bHost3.out) && /EMPTY_ISSUE_BODY_WRITE/.test(bHost3.out));

{
  const empty = path.join(os.tmpdir(), `bg-empty-${process.pid}.md`);
  fs.writeFileSync(empty, '');
  const b2 = runHook(`gh issue edit 5 --body-file ${empty}`);
  ok('blocks an empty --body-file (exit 2)', b2.code === 2 && /"decision":"block"/.test(b2.out));
  fs.unlinkSync(empty);
}

{
  const whitespace = path.join(os.tmpdir(), `bg-ws-${process.pid}.md`);
  fs.writeFileSync(whitespace, '   \n\t \n');
  const b3 = runHook(`gh pr edit 5 --body-file ${whitespace}`);
  ok('blocks a whitespace-only --body-file (exit 2)', b3.code === 2 && /"decision":"block"/.test(b3.out));
  fs.unlinkSync(whitespace);
}

const b4 = runHook('gh api --method PATCH repos/o/r/issues/5 -f body=');
ok('blocks an empty gh api body= (exit 2)', b4.code === 2 && /"decision":"block"/.test(b4.out));

// --- end-to-end: block via short flags (-b / -F, gh's documented aliases) ---
const b5 = runHook('gh issue edit 5 -b ""');
ok('blocks an empty short -b (issue edit, exit 2)', b5.code === 2 && /"decision":"block"/.test(b5.out));

const b6 = runHook('gh pr edit 5 -b ""');
ok('blocks an empty short -b (pr edit, exit 2)', b6.code === 2 && /"decision":"block"/.test(b6.out));

{
  const shortEmpty = path.join(os.tmpdir(), `bg-short-empty-${process.pid}.md`);
  fs.writeFileSync(shortEmpty, '');
  const b7 = runHook(`gh issue edit 5 -F ${shortEmpty}`);
  ok('blocks an empty short -F body-file (exit 2)', b7.code === 2 && /"decision":"block"/.test(b7.out));
  fs.unlinkSync(shortEmpty);
}

const a5 = runHook('gh issue edit 5 -b "real content"');
ok('allows a non-empty short -b (exit 0)', a5.code === 0 && a5.out.trim() === '');

// --- unit: ghBodyWrite() recognizes short flags directly ---
ok('ghBodyWrite recognizes -b (issue edit)',
  (() => { const r = ghBodyWrite('gh issue edit 5 -b "hi"'); return r && r.kind === 'issue' && r.body === 'hi'; })());
{
  const tmp = path.join(os.tmpdir(), `bg-shortfile-${process.pid}.md`);
  fs.writeFileSync(tmp, 'content\n');
  const r = ghBodyWrite(`gh pr edit 5 -F ${tmp}`);
  ok('ghBodyWrite recognizes -F (pr edit)', r && r.kind === 'pr' && r.body === 'content\n');
  fs.unlinkSync(tmp);
}
// -b must not accidentally match the "-b" inside "--body" itself.
ok('ghBodyWrite still resolves --body correctly alongside the -b alias',
  (() => { const r = ghBodyWrite('gh issue edit 5 --body "hi"'); return r && r.kind === 'issue' && r.body === 'hi'; })());

// --- end-to-end: block via gh api empty-body forms ---
const b8 = runHook('gh api --method PATCH repos/o/r/issues/5 -f body=""');
ok('blocks gh api -f body="" (literal empty double-quotes, exit 2)', b8.code === 2 && /"decision":"block"/.test(b8.out));

const b9 = runHook("gh api --method PATCH repos/o/r/issues/5 -f body=''");
ok("blocks gh api -f body='' (literal empty single-quotes, exit 2)", b9.code === 2 && /"decision":"block"/.test(b9.out));

{
  const apiEmpty = path.join(os.tmpdir(), `bg-api-empty-${process.pid}.md`);
  fs.writeFileSync(apiEmpty, '');
  const b10 = runHook(`gh api --method PATCH repos/o/r/issues/5 -F body=@${apiEmpty}`);
  ok('blocks gh api -F body=@<empty file> (exit 2)', b10.code === 2 && /"decision":"block"/.test(b10.out));
  fs.unlinkSync(apiEmpty);
}

const a6 = runHook('gh api --method PATCH repos/o/r/issues/5 -F body=@-');
ok('allows gh api -F body=@- (stdin, unknowable, exit 0)', a6.code === 0 && a6.out.trim() === '');

{
  const apiFull = path.join(os.tmpdir(), `bg-api-full-${process.pid}.md`);
  fs.writeFileSync(apiFull, 'real content\n');
  const a7 = runHook(`gh api --method PATCH repos/o/r/issues/5 -f body=@${apiFull}`);
  ok('allows a non-empty gh api -f body=@<file> (exit 0)', a7.code === 0 && a7.out.trim() === '');
  fs.unlinkSync(apiFull);
}

// --- end-to-end: block via ~-expanded --body-file (fs.readFileSync does not expand ~) ---
{
  const homeRel = `.bg-tilde-test-${process.pid}.md`;
  const homeAbs = path.join(os.homedir(), homeRel);
  fs.writeFileSync(homeAbs, '');
  const b11 = runHook(`gh issue edit 5 --body-file ~/${homeRel}`);
  ok('blocks an empty ~/-prefixed --body-file (exit 2)', b11.code === 2 && /"decision":"block"/.test(b11.out));
  fs.unlinkSync(homeAbs);
}

// --- end-to-end: allow ---
const a1 = runHook('gh issue edit 5 --body "not empty"');
ok('allows a non-empty body write (exit 0, no output)', a1.code === 0 && a1.out.trim() === '');
const a2 = runHook('gh issue view 5 --json body'); // read, not a write
ok('allows a read (exit 0)', a2.code === 0 && a2.out.trim() === '');
const a3 = runHook('gh issue comment 5 --body ""'); // excluded verb, even though empty
ok('allows an empty gh issue comment (excluded verb, exit 0)', a3.code === 0 && a3.out.trim() === '');
const a4 = runHook('gh issue edit 5 --body "$(cat f)"'); // unknowable, can't prove empty
ok('allows an unknowable (shell-expansion) body (exit 0)', a4.code === 0 && a4.out.trim() === '');

// --- crash-safety ---
try {
  execFileSync('node', [HOOK], { input: 'not json at all {{{' });
  ok('unparseable stdin does not throw (exit 0)', true);
} catch (e) {
  ok('unparseable stdin exits 0', e.status === 0);
}
const c2 = runHook('gh issue edit 5 --add-label x'); // non-body gh command
ok('a non-body gh command exits 0', c2.code === 0 && c2.out.trim() === '');

console.log(`✓ body-guard: ${passed} assertions passed`);
