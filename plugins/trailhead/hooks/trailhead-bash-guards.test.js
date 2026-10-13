#!/usr/bin/env node
// Tests for trailhead-bash-guards.js. Run: node trailhead-bash-guards.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK = path.join(__dirname, 'trailhead-bash-guards.js');
const {
  parseModGuards, parseGuardsArg, runGuards, MOD_GUARDS_FRESH_MS, GUARD_ORDER,
} = require('./trailhead-bash-guards.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, actual, expected) => { assert.deepStrictEqual(actual, expected, name); passed++; };

// Run the merged hook end-to-end: tool_input JSON on stdin, capture {code, out, err}.
function runHook(command, { env = {}, args = [], hook = HOOK } = {}) {
  const input = JSON.stringify({ tool_input: { command } });
  const r = spawnSync('node', [hook, ...args], { input, env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}
const codeOf = (r) => (r.out ? JSON.parse(r.out).code : undefined);

// One command per guard that it (and only it) blocks.
const BAD_COMMIT = 'git commit -m "not conventional"';
const BAD_SECRET = 'gh issue comment 5 --body "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx"';
const BAD_INSTALL = 'npm install left-pad';
const BAD_SEARCH = 'cd x && grep y z';
const BAD_BODY = 'gh issue edit 5 --body ""';

// --- unit: constants ---
eq('guard order is fixed', GUARD_ORDER, ['commit', 'secret', 'install', 'search', 'body']);
ok('freshness window is 5s', MOD_GUARDS_FRESH_MS === 5000);

// --- unit: parseModGuards ---
const NOW = 1_700_000_000_000;
eq('fresh stamp lists the guards', [...parseModGuards(`commit,search@${NOW - 100}`, NOW)].sort(), ['commit', 'search']);
eq('age 0 is fresh', [...parseModGuards(`commit@${NOW}`, NOW)], ['commit']);
eq('age exactly the window is fresh', [...parseModGuards(`commit@${NOW - MOD_GUARDS_FRESH_MS}`, NOW)], ['commit']);
eq('age window+1 is stale', parseModGuards(`commit@${NOW - MOD_GUARDS_FRESH_MS - 1}`, NOW).size, 0);
eq('future-dated stamp is ignored', parseModGuards(`commit@${NOW + 1}`, NOW).size, 0);
for (const bad of ['commit', '@123', 'commit@abc', ',@1', '', undefined, 'commit,@1', 'commit@1@2', 'commit@-5']) {
  eq(`malformed ${JSON.stringify(bad)} skips nothing`, parseModGuards(bad, 1).size, 0);
}
eq('unknown names are ignored', [...parseModGuards(`commit,bogus@${NOW}`, NOW)], ['commit']);

// --- unit: parseGuardsArg ---
eq('no --guards -> all five', parseGuardsArg([]), GUARD_ORDER);
eq('valid subset keeps canonical order', parseGuardsArg(['--guards=body,commit']), ['commit', 'body']);
eq('empty --guards -> all five', parseGuardsArg(['--guards=']), GUARD_ORDER);
eq('malformed --guards -> all five', parseGuardsArg(['--guards=commit,,body']), GUARD_ORDER);
eq('any unknown name invalidates the whole list', parseGuardsArg(['--guards=commit,secert']), GUARD_ORDER);

// --- unit: runGuards with fake evaluators ---
const allow = () => ({ kind: 'allow' });
const blocker = (code) => () => ({ kind: 'block', payload: { decision: 'block', code, reason: 'r' } });
{
  const calls = [];
  const spy = (n, f) => (c, o) => { calls.push(n); return f(c, o); };
  const r = runGuards('x', {
    now: NOW, env: {},
    evaluators: {
      commit: spy('commit', () => { throw new Error('boom'); }),
      secret: spy('secret', allow), install: spy('install', blocker('I')),
      search: spy('search', blocker('S')), body: spy('body', allow),
    },
  });
  eq('a throwing guard counts as allow and the next one still blocks', r.code, 2);
  eq('the first block wins', JSON.parse(r.stdout).code, 'I');
  eq('later guards are not run after a block', calls, ['commit', 'secret', 'install']);
}
{
  const r = runGuards('x', {
    now: NOW, env: { TRAILHEAD_MOD_GUARDS: `commit@${NOW}` },
    evaluators: { commit: blocker('C'), secret: allow, install: allow, search: allow, body: allow },
  });
  eq('a fresh stamp skips the listed guard', r.code, 0);
}
{
  const adv = (t) => () => ({ kind: 'advise', stderr: `${t}\n`, payload: { hookSpecificOutput: { additionalContext: t } } });
  const r = runGuards('x', {
    now: NOW, env: {},
    evaluators: { commit: adv('a'), secret: adv('b'), install: allow, search: allow, body: allow },
  });
  eq('advisories exit 0', r.code, 0);
  eq('advisory stderr lines are all written', r.stderr, 'a\nb\n');
  eq('advisories are joined in one context', JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'a\nb');
}

// --- end to end: each guard's block, exact payload, exit 2 ---
const { evaluate: evCommit } = require('./trailhead-commit-guard.js');
const { evaluate: evSecret } = require('./trailhead-secret-guard.js');
const { evaluate: evInstall } = require('./trailhead-install-guard.js');
const { evaluate: evSearch } = require('./trailhead-search-guard.js');
const { evaluate: evBody } = require('./trailhead-body-guard.js');
for (const [name, cmd, ev] of [
  ['commit', BAD_COMMIT, evCommit], ['secret', BAD_SECRET, evSecret], ['install', BAD_INSTALL, evInstall],
  ['search', BAD_SEARCH, evSearch], ['body', BAD_BODY, evBody],
]) {
  const r = runHook(cmd);
  const want = ev(cmd);
  ok(`${name}: evaluator blocks the probe`, want.kind === 'block');
  eq(`${name}: exit 2`, r.code, 2);
  eq(`${name}: exact payload on stdout`, r.out, JSON.stringify(want.payload));
}

// --- end to end: clean, unparseable, stdin shapes ---
{
  const r = runHook('git status');
  eq('clean command: exit 0', r.code, 0);
  eq('clean command: empty stdout', r.out, '');
  eq('clean command: empty stderr', r.err, '');
  const bad = spawnSync('node', [HOOK], { input: 'not json {{' });
  eq('unparseable input: exit 0', bad.status, 0);
  const nul = spawnSync('node', [HOOK], { input: 'null' });
  eq('null input: exit 0', nul.status, 0);
}

// --- end to end: first block wins ---
{
  const r = runHook(`${BAD_COMMIT} && ${BAD_SEARCH}`);
  ok('the probe trips both commit and search', evSearch(`${BAD_COMMIT} && ${BAD_SEARCH}`).kind === 'block');
  eq('first block wins: exit 2', r.code, 2);
  eq('first block wins: commit payload', codeOf(r) !== 'SEARCH_HYGIENE_VIOLATION', true);
  eq('first block wins: single payload', r.out, JSON.stringify(evCommit(`${BAD_COMMIT} && ${BAD_SEARCH}`).payload));
}

// --- end to end: TRAILHEAD_MOD_GUARDS ---
{
  const fresh = runHook(BAD_COMMIT, { env: { TRAILHEAD_MOD_GUARDS: `commit@${Date.now()}` } });
  eq('fresh stamp lets the skipped guard through', fresh.code, 0);
  const stale = runHook(BAD_COMMIT, { env: { TRAILHEAD_MOD_GUARDS: `commit@${Date.now() - 60000}` } });
  eq('stale stamp blocks', stale.code, 2);
  const junk = runHook(BAD_COMMIT, { env: { TRAILHEAD_MOD_GUARDS: 'commit' } });
  eq('malformed stamp blocks', junk.code, 2);
  const multi = `${BAD_INSTALL} && ${BAD_SEARCH}`;
  const part = runHook(multi, { env: { TRAILHEAD_MOD_GUARDS: `commit,search@${Date.now()}` } });
  eq('a fresh list skips exactly the listed guards: install still blocks', codeOf(part), 'UNVETTED_PACKAGE_INSTALL');
  const all = runHook(multi, { env: { TRAILHEAD_MOD_GUARDS: `install,search@${Date.now()}` } });
  eq('both listed guards skipped: passes', all.code, 0);
}

// --- end to end: failure posture ---
{
  const env = { TRAILHEAD_SECRETGUARD_THROW: '1' };
  const alone = runHook('gh issue comment 5 --body "hello"', { env });
  eq('secret advisory alone: exit 0', alone.code, 0);
  ok('secret advisory alone: stderr names the failed scan', /could not scan this issue write/.test(alone.err));
  ok('secret advisory alone: additionalContext on stdout',
    /could NOT complete its scan/.test(JSON.parse(alone.out).hookSpecificOutput.additionalContext));
  const both = runHook('gh issue edit 5 --body ""', { env });
  eq('a faulted guard does not stop the next from blocking', both.code, 2);
  eq('later block payload on stdout', codeOf(both), 'EMPTY_ISSUE_BODY_WRITE');
  ok('earlier advisory stderr survives the later block', /could not scan this issue write/.test(both.err));
  ok('advisory stdout is dropped on block', !/hookSpecificOutput/.test(both.out));
}

// --- end to end: --guards selection and module loading, on a throwaway copy ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guards-'));
  try {
    fs.cpSync(__dirname, tmp, {
      recursive: true,
      filter: (src) => path.basename(src) !== 'mod' && !src.endsWith('.test.js'),
    });
    const hook = path.join(tmp, 'trailhead-bash-guards.js');
    fs.rmSync(path.join(tmp, 'trailhead-search-guard.js'));

    const codex = runHook(BAD_SEARCH, { hook, args: ['--guards=commit,secret,install,body'] });
    eq('--guards without search never loads search-guard', codex.code, 0);
    eq('--guards without search: no warning', codex.err, '');
    const still = runHook(BAD_INSTALL, { hook, args: ['--guards=commit,secret,install,body'] });
    eq('--guards subset still blocks with its guards', still.code, 2);
    const only = runHook(BAD_INSTALL, { hook, args: ['--guards=commit'] });
    eq('unselected guards do not run', only.code, 0);

    for (const bad of ['--guards=', '--guards=commit,secert', '--guards=commit,,body']) {
      const r = runHook(BAD_INSTALL, { hook, args: [bad] });
      eq(`${bad}: falls back to all five (install blocks)`, r.code, 2);
      const clean = runHook('git status', { hook, args: [bad] });
      ok(`${bad}: all five are selected (the missing search module is reported)`, /search/.test(clean.err));
    }

    const missing = runHook(`${BAD_BODY} && ${BAD_SEARCH}`, { hook });
    eq('a module that fails to load is skipped, the others still block', codeOf(missing), 'EMPTY_ISSUE_BODY_WRITE');
    ok('a load failure is a one-line stderr warning naming the guard',
      missing.err.trim().split('\n').length === 1 && /search/.test(missing.err));
    const clean = runHook('git status', { hook });
    eq('a load failure alone still exits 0', clean.code, 0);
    ok('a load failure reaches the session as an advisory naming the guard',
      /could NOT load the search guard/.test(JSON.parse(clean.out).hookSpecificOutput.additionalContext));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- #227: unmodelled constructs through the merged runner ---
{
  const r1 = runHook('alias g=gh; g issue comment 1 --body x');
  eq('secret-guard blocks a hidden gh write behind an alias', [r1.code, codeOf(r1)], [2, 'SECRET_GUARD_UNMODELLED_CONSTRUCT']);
  const r2 = runHook('echo ${ gh issue comment 1 --body x; }');
  eq('secret-guard blocks a write inside a function substitution', [r2.code, codeOf(r2)], [2, 'SECRET_GUARD_UNMODELLED_CONSTRUCT']);
  const r3 = runHook("gh api -X PATCH repos/o/r/issues/1 -f 'body'=\"\"");
  eq('body-guard blocks a quoted api body key with an empty body', [r3.code, codeOf(r3)], [2, 'BODY_GUARD_UNMODELLED_CONSTRUCT']);
  const r4 = runHook('printf -v B %s x; gh issue edit 1 --body-file ~/nonexistent-227.md');
  eq('a state construct before a tilde body file blocks', r4.code, 2);
  eq('a plain alias passes', runHook("alias ll='ls -l'").code, 0);
  eq('a literal write after source passes', runHook(". venv/bin/activate && gh issue edit 1 --body 'hello'").code, 0);
}

// --- every existing guard suite, re-run through the merged hook ---
for (const name of ['commit', 'secret', 'install', 'search', 'body']) {
  const file = path.join(__dirname, `trailhead-${name}-guard.test.js`);
  const r = spawnSync('node', [file], { env: { ...process.env, TRAILHEAD_GUARD_HOOK: HOOK } });
  if (r.status !== 0) process.stderr.write(r.stdout.toString() + r.stderr.toString());
  eq(`${name}-guard suite passes through the merged hook`, r.status, 0);
}

// --- registration: one Bash entry, one command (the merged hook) ---
{
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf8'));
  const bashGroups = reg.hooks.PreToolUse.filter((g) => g.matcher === 'Bash');
  eq('hooks.json has exactly one PreToolUse entry with matcher Bash', bashGroups.length, 1);
  eq('that entry holds exactly one command', bashGroups[0].hooks.length, 1);
  ok('and it is the merged hook', bashGroups[0].hooks[0].command.includes('trailhead-bash-guards.js'));
  ok('no legacy guard script is registered anywhere in hooks.json',
    !/trailhead-(commit|secret|install|search|body)-guard\.js/.test(JSON.stringify(reg)));
}

console.log(`trailhead-bash-guards.test.js: ${passed} checks passed`);
