#!/usr/bin/env node
// Tests for trailhead-test-guard.js. Run: node trailhead-test-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// TRAILHEAD_GUARD_HOOK re-runs this suite through the merged trailhead-bash-guards.js.
const HOOK = process.env.TRAILHEAD_GUARD_HOOK || path.join(__dirname, 'trailhead-test-guard.js');
const { evaluate } = require('./trailhead-test-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-guard-'));
const GLOBAL = path.join(tmp, 'global'); // CLAUDE_CONFIG_DIR
fs.mkdirSync(path.join(GLOBAL, 'trailhead'), { recursive: true });
const ENV = { CLAUDE_CONFIG_DIR: GLOBAL };
const setGlobal = (cfg) => {
  const f = path.join(GLOBAL, 'trailhead', 'config.json');
  if (cfg === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
};

let n = 0;
// A temp repo (.git dir) whose project config is `cfg` (object, raw string, or null for none).
function repo(cfg) {
  const dir = path.join(tmp, `repo${n++}`);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
  if (cfg !== null) {
    fs.mkdirSync(path.join(dir, '.trailhead'));
    fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  }
  return dir;
}

const blocked = (cmd, cwd) => { const v = evaluate(cmd, { cwd, env: ENV }); return !!v && v.kind === 'block'; };
const NPM = repo({ testing: { full: 'npm test' } });

function runHook(command, cwd) {
  const input = JSON.stringify({ tool_input: { command }, cwd });
  const r = spawnSync('node', [HOOK], { input, cwd: tmp, env: { ...process.env, ...ENV } });
  return { code: r.status, out: r.stdout.toString() };
}

setGlobal(null);

// --- blocks ---
for (const c of [
  'npm test',
  'npm test 2>&1 | tail -20',
  'npm test > out.log 2>&1',
  'CI=1 npm test',
  'timeout 600 npm test',
  'timeout -s KILL -k 5 600 npm test',
  'timeout --signal=KILL 10m npm test',
  'env CI=1 FOO=bar npm test',
  'env -i npm test',
  'time npm test',
  'command npm test',
  'nice npm test',
  'nice -n 10 npm test',
  'nice -n10 npm test',
  'nice -5 npm test',
  'nice -n 10 timeout 600 env CI=1 npm test',
  'npm test -- --coverage',
  'npm test --silent',
  'echo hi && npm test',
  'npm test; echo done',
  'npm "test"',
]) ok(`blocks: ${c}`, blocked(c, NPM));

// --- passes ---
for (const c of [
  'npm test -- hooks/x.test.js',
  'npm test hooks/x.test.js',
  'npm run lint',
  'npm run test',
  'npm install',
  'node /x/trailhead-test-run.js run --repo .',
  'node /x/trailhead-test-run.js run --repo . && npm test -- a.test.js',
  'cd sub && npm test',
  'pushd sub; npm test',
  'echo npm test',
  'git commit -m "npm test"',
  '',
]) ok(`passes: ${c}`, !blocked(c, NPM));

// --- compound testing.full ---
const COMPOUND = repo({ testing: { full: 'npm run build && npm test' } });
ok('compound blocks as written', blocked('npm run build && npm test', COMPOUND));
ok('compound blocks across ; and |', blocked('npm run build ; npm test', COMPOUND) && blocked('npm run build | npm test', COMPOUND));
ok('compound blocks with wrappers and flags', blocked('CI=1 npm run build && timeout 9 npm test --silent', COMPOUND));
ok('compound: only the last statement alone passes', !blocked('npm test', COMPOUND));
ok('compound: only the first statement alone passes', !blocked('npm run build', COMPOUND));
ok('compound: extra arg on a non-last statement passes', !blocked('npm run build --prod && npm test', COMPOUND));
ok('compound: focused last statement passes', !blocked('npm run build && npm test -- a.test.js', COMPOUND));
ok('compound: a cd in between passes', !blocked('cd x && npm run build && npm test', COMPOUND));

// --- node --test style ---
const NODE = repo({ testing: { full: 'node --test' } });
ok('node --test blocks bare', blocked('node --test', NODE));
ok('node --test with a file passes', !blocked('node --test a.test.js', NODE));
ok('node --test with --test-reporter flag blocks', blocked('node --test --test-reporter=spec', NODE));

// --- off ---
ok('off: no config at all', !blocked('npm test', repo(null)));
ok('off: config without the key', !blocked('npm test', repo({ testing: { targeted: 'x {files}' } })));
ok('off: invalid JSON', !blocked('npm test', repo('{nope')));
ok('off: non-string value', !blocked('npm test', repo({ testing: { full: 5 } })));
ok('off: empty value', !blocked('npm test', repo({ testing: { full: '  ' } })));
ok('off: testing not an object', !blocked('npm test', repo({ testing: 'npm test' })));
ok('off: no git repo and no global', !blocked('npm test', tmp));

// --- config layers ---
ok('flat key blocks', blocked('npm test', repo({ 'testing.full': 'npm test' })));
{
  const both = repo({ testing: { full: 'npm test' }, 'testing.full': 'yarn test' });
  ok('nested wins over flat', blocked('npm test', both) && !blocked('yarn test', both));
}
{
  setGlobal({ testing: { full: 'make check' } });
  ok('global-only testing.full blocks', blocked('make check', repo(null)));
  ok('global applies when the project lacks the key', blocked('make check', repo({ testing: { targeted: 'x {files}' } })));
  ok('project replaces global', !blocked('make check', NPM) && blocked('npm test', NPM));
  ok('invalid project value replaces global (off)', !blocked('make check', repo({ testing: { full: 3 } })));
  ok('invalid project JSON falls back to global', blocked('make check', repo('{nope')));
  setGlobal('{nope');
  ok('invalid global JSON is off', !blocked('npm test', repo(null)));
  setGlobal({ 'testing.full': 'make check' });
  ok('flat global blocks', blocked('make check', repo(null)));
  setGlobal(null);
}
ok('project config found from a nested cwd', blocked('npm test', path.join(NPM, 'sub', 'deep')));
ok('worktree-style .git file is a top level', (() => {
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(path.join(wt, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
  fs.writeFileSync(path.join(wt, '.trailhead', 'config.json'), JSON.stringify({ testing: { full: 'npm test' } }));
  return blocked('npm test', wt);
})());

// --- verdict shape ---
{
  const v = evaluate('npm test', { cwd: NPM, env: ENV });
  ok('block payload shape', v.kind === 'block' && v.payload.decision === 'block' && v.payload.code === 'UNQUEUED_FULL_TEST_RUN');
  ok('reason names the command, focused tests and the helper',
    v.payload.reason.includes('`npm test`') && /focused tests/.test(v.payload.reason) && /trailhead-test-run\.js run --repo /.test(v.payload.reason));
  ok('reason names the repo root', v.payload.reason.includes(NPM));
  ok('allow verdict is null', evaluate('ls', { cwd: NPM, env: ENV }) === null);
  ok('never throws on garbage', evaluate(undefined, { cwd: NPM, env: ENV }) === null && evaluate('npm test', undefined) === null);
}

// --- end to end ---
{
  const h = runHook('npm test 2>&1 | tail -20', NPM);
  const v = evaluate('npm test 2>&1 | tail -20', { cwd: NPM, env: ENV });
  ok('hook exits 2', h.code === 2);
  ok('hook payload is the verdict payload', h.out === JSON.stringify(v.payload));
  const p = runHook('npm test -- a.test.js', NPM);
  ok('hook allows a focused run silently', p.code === 0 && p.out === '');
  const off = runHook('npm test', repo(null));
  ok('hook allows when off', off.code === 0 && off.out === '');
  const bad = spawnSync('node', [HOOK], { input: 'not json', cwd: tmp, env: { ...process.env, ...ENV } });
  ok('unparseable input allows', bad.status === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`trailhead-test-guard: ${passed} checks passed`);
