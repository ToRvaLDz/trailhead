#!/usr/bin/env node
// Tests for templates/trailhead-base-preflight.js. Run: node base-preflight.test.js
// No framework: plain asserts, same style as isolation-copy.test.js.
//
// Every scenario uses real git repos: a local bare `origin`, a working clone, and a
// second clone ("other") that pushes new trunk commits to make the working clone stale.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-base-preflight.js');
const { main, parseArgs } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  passed++;
};

const mktmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-base-preflight-test-')));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const gitOk = (dir, ...args) => { try { git(dir, ...args); return true; } catch (err) { return false; } };

function identify(dir) {
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
}

function commitFile(dir, rel, content, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
  git(dir, 'add', rel);
  git(dir, 'commit', '-q', '-m', msg || `edit ${rel}`);
}

// A bare origin plus a working clone on `trunk`, one commit pushed.
function mkWorld(trunk = 'main') {
  const origin = mktmp();
  git(origin, 'init', '--bare', '-q', '-b', trunk);
  const work = mktmp();
  git(work, 'init', '-q', '-b', trunk);
  identify(work);
  git(work, 'remote', 'add', 'origin', origin);
  commitFile(work, 'README.md', 'x\n', 'init');
  git(work, 'push', '-q', '-u', 'origin', trunk);
  return { origin, work, trunk };
}

// Pushes `n` commits to the origin trunk from a throwaway clone.
function advanceOrigin(world, n, file = 'upstream.txt') {
  const other = mktmp();
  execFileSync('git', ['clone', '-q', world.origin, other], { stdio: 'ignore' });
  identify(other);
  git(other, 'checkout', '-q', world.trunk);
  for (let i = 0; i < n; i++) commitFile(other, n === 1 && file !== 'upstream.txt' ? file : `${path.basename(file, '.txt')}-${i}.txt`, `u${i}\n`, `upstream ${i}`);
  git(other, 'push', '-q', 'origin', world.trunk);
  return git(other, 'rev-parse', 'HEAD');
}

function run(argv, { env = {}, cwd = '/' } = {}) {
  const chunks = [];
  const errChunks = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { cwd, env: { HOME: '/nonexistent-home', ...env }, stdout: { write: (s) => chunks.push(s) } });
  } finally {
    process.stderr.write = realErr;
  }
  const lines = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code, out: lines[0], lines, err: errChunks.join('') };
}

const emptyHome = mktmp();
const envNoGlobal = { CLAUDE_CONFIG_DIR: emptyHome };
const pre = (dir, extra = [], opts = {}) => run(['--repo', dir, ...extra], { env: envNoGlobal, ...opts });
const writeConfig = (dir, cfg) => {
  fs.mkdirSync(path.join(dir, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
};
const inProgress = (dir) => {
  const gd = git(dir, 'rev-parse', '--absolute-git-dir');
  return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].some((n) => fs.existsSync(path.join(gd, n)));
};
const cleanTree = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=no') === '';

// --- parseArgs -----------------------------------------------------------------
ok('parseArgs: missing --repo', parseArgs([]).error !== undefined);
ok('parseArgs: unknown flag', parseArgs(['--repo', 'x', '--nope']).error !== undefined);
ok('parseArgs: value needed', parseArgs(['--repo']).error !== undefined);
{
  const a = parseArgs(['--repo', 'r', '--config-root', 'c', '--trunk', 't', '--sync', '--no-fetch']);
  eq('parseArgs: full', a, { repo: 'r', 'config-root': 'c', trunk: 't', sync: true, 'no-fetch': true });
}

// --- usage errors --------------------------------------------------------------
{
  const r = run([]);
  eq('usage: exit 2 without --repo', r.code, 2);
  ok('usage: message on stderr', /usage/.test(r.err));
  eq('usage: unknown flag exits 2', run(['--repo', '/', '--wat']).code, 2);
}

// --- current -------------------------------------------------------------------
{
  const w = mkWorld();
  const r = pre(w.work);
  eq('current: exit 0', r.code, 0);
  eq('current: status', r.out.status, 'current');
  eq('current: trunk', r.out.trunk, 'main');
  eq('current: base', r.out.base, 'origin/main');
  eq('current: behind', r.out.behind, 0);
  eq('current: testsRequired false', r.out.testsRequired, false);
  eq('current: no checks configured passes', r.out.checksOk, true);
  eq('current: one JSON line', r.lines.length, 1);
}

// --- behind on the trunk: fetch advances origin/main, ff sync -------------------
{
  const w = mkWorld();
  const tip = advanceOrigin(w, 3);
  const r = pre(w.work);
  eq('behind: status without --sync', r.out.status, 'behind');
  eq('behind: counts commits', r.out.behind, 3);
  eq('fetch: origin/main advanced to the remote tip', git(w.work, 'rev-parse', 'origin/main'), tip);
  eq('behind: tree untouched without --sync', git(w.work, 'rev-parse', 'HEAD') === tip, false);
  const s = pre(w.work, ['--sync']);
  eq('ff: status', s.out.status, 'synced');
  eq('ff: method', s.out.method, 'ff');
  eq('ff: pulled', s.out.pulled, 3);
  eq('ff: testsRequired', s.out.testsRequired, true);
  eq('ff: HEAD at the remote tip', git(w.work, 'rev-parse', 'HEAD'), tip);
}

// --- trunk diverged from origin while on it: rebase ----------------------------
{
  const w = mkWorld();
  commitFile(w.work, 'local.txt', 'l\n', 'local unpushed');
  advanceOrigin(w, 2);
  const s = pre(w.work, ['--sync']);
  eq('trunk rebase: status', s.out.status, 'synced');
  eq('trunk rebase: method', s.out.method, 'rebase');
  eq('trunk rebase: pulled', s.out.pulled, 2);
  eq('trunk rebase: local commit kept on top', git(w.work, 'log', '-1', '--format=%s'), 'local unpushed');
  eq('trunk rebase: ahead is the one local commit', git(w.work, 'rev-list', '--count', 'origin/main..HEAD'), '1');
}

// --- ticket branch, unpublished: rebase ----------------------------------------
{
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t1');
  commitFile(w.work, 'ticket.txt', 't\n', 'ticket work');
  advanceOrigin(w, 2);
  const r = pre(w.work);
  eq('branch: base is origin/main when local main is behind', r.out.base, 'origin/main');
  eq('branch: behind', r.out.behind, 2);
  eq('branch: ahead', r.out.ahead, 1);
  const s = pre(w.work, ['--sync']);
  eq('branch unpublished: method rebase', s.out.method, 'rebase');
  eq('branch unpublished: linear history', git(w.work, 'rev-list', '--merges', '--count', 'HEAD'), '0');
  eq('branch unpublished: ticket commit on top', git(w.work, 'log', '-1', '--format=%s'), 'ticket work');
}

// --- ticket branch, published: merge, never a rewrite --------------------------
{
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t2');
  commitFile(w.work, 'ticket.txt', 't\n', 'ticket work');
  git(w.work, 'push', '-q', '-u', 'origin', 'trailhead/t2');
  const before = git(w.work, 'rev-parse', 'HEAD');
  advanceOrigin(w, 1);
  const s = pre(w.work, ['--sync']);
  eq('branch published: status', s.out.status, 'synced');
  eq('branch published: method merge', s.out.method, 'merge');
  eq('branch published: one merge commit', git(w.work, 'rev-list', '--merges', '--count', 'HEAD'), '1');
  ok('branch published: published commit still an ancestor', gitOk(w.work, 'merge-base', '--is-ancestor', before, 'HEAD'));
}

// --- ticket branch with the local trunk ahead of origin ------------------------
{
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t3');
  git(w.work, 'checkout', '-q', 'main');
  commitFile(w.work, 'integrated.txt', 'i\n', 'integrated locally, not pushed');
  git(w.work, 'checkout', '-q', 'trailhead/t3');
  const r = pre(w.work);
  eq('local trunk ahead: base is the local trunk', r.out.base, 'main');
  eq('local trunk ahead: branch is behind the local trunk', r.out.behind, 1);
  eq('local trunk ahead: status', r.out.status, 'behind');
  const s = pre(w.work, ['--sync']);
  eq('local trunk ahead: synced onto the local trunk', s.out.status, 'synced');
  eq('local trunk ahead: pulled the local commit', git(w.work, 'log', '-1', '--format=%s'), 'integrated locally, not pushed');
}

// --- ticket branch with a diverged trunk: stop, nothing synced -----------------
{
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t4');
  git(w.work, 'checkout', '-q', 'main');
  commitFile(w.work, 'integrated.txt', 'i\n', 'integrated locally, not pushed');
  git(w.work, 'checkout', '-q', 'trailhead/t4');
  advanceOrigin(w, 1);
  const head = git(w.work, 'rev-parse', 'HEAD');
  const s = pre(w.work, ['--sync']);
  eq('trunk-diverged: status', s.out.status, 'trunk-diverged');
  eq('trunk-diverged: HEAD unchanged', git(w.work, 'rev-parse', 'HEAD'), head);
  eq('trunk-diverged: no testsRequired', s.out.testsRequired, false);
  eq('trunk-diverged: checks not ok', s.out.checksOk, false);
}

// --- conflicts: aborted, tree unchanged, paths listed --------------------------
{
  // rebase conflict on the trunk
  const w = mkWorld();
  commitFile(w.work, 'clash.txt', 'local\n', 'local clash');
  const other = mktmp();
  execFileSync('git', ['clone', '-q', w.origin, other], { stdio: 'ignore' });
  identify(other);
  commitFile(other, 'clash.txt', 'remote\n', 'remote clash');
  git(other, 'push', '-q', 'origin', 'main');
  const head = git(w.work, 'rev-parse', 'HEAD');
  const s = pre(w.work, ['--sync']);
  eq('rebase conflict: status', s.out.status, 'conflict');
  eq('rebase conflict: paths', s.out.conflicts, ['clash.txt']);
  eq('rebase conflict: HEAD restored', git(w.work, 'rev-parse', 'HEAD'), head);
  ok('rebase conflict: no rebase left behind', !inProgress(w.work));
  ok('rebase conflict: tree clean', cleanTree(w.work));
  eq('rebase conflict: file content untouched', fs.readFileSync(path.join(w.work, 'clash.txt'), 'utf8'), 'local\n');
}
{
  // merge conflict on a published ticket branch
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t5');
  commitFile(w.work, 'clash.txt', 'branch\n', 'branch clash');
  git(w.work, 'push', '-q', '-u', 'origin', 'trailhead/t5');
  const other = mktmp();
  execFileSync('git', ['clone', '-q', w.origin, other], { stdio: 'ignore' });
  identify(other);
  git(other, 'checkout', '-q', 'main');
  commitFile(other, 'clash.txt', 'trunk\n', 'trunk clash');
  git(other, 'push', '-q', 'origin', 'main');
  const head = git(w.work, 'rev-parse', 'HEAD');
  writeConfig(w.work, { preflight: { checks: ['echo should-not-run'] } });
  const s = pre(w.work, ['--sync']);
  eq('merge conflict: status', s.out.status, 'conflict');
  eq('merge conflict: paths', s.out.conflicts, ['clash.txt']);
  eq('merge conflict: HEAD restored', git(w.work, 'rev-parse', 'HEAD'), head);
  ok('merge conflict: no merge left behind', !inProgress(w.work));
  eq('merge conflict: checks skipped', s.out.checks, []);
  eq('merge conflict: checksOk false', s.out.checksOk, false);
}

// --- a non-conflict failure mid-operation: state preserved ---------------------
{
  // untracked file that the fast-forward would overwrite
  const w = mkWorld();
  advanceOrigin(w, 1, 'blocker.txt');
  fs.writeFileSync(path.join(w.work, 'blocker.txt'), 'mine\n');
  const head = git(w.work, 'rev-parse', 'HEAD');
  const s = pre(w.work, ['--sync']);
  eq('untracked blocks ff: status', s.out.status, 'sync-failed');
  ok('untracked blocks ff: git message reported', typeof s.out.message === 'string' && s.out.message.length > 0);
  eq('untracked blocks ff: HEAD unchanged', git(w.work, 'rev-parse', 'HEAD'), head);
  eq('untracked blocks ff: file preserved', fs.readFileSync(path.join(w.work, 'blocker.txt'), 'utf8'), 'mine\n');
  ok('untracked blocks ff: nothing in progress', !inProgress(w.work));
}
{
  // same, mid-rebase on an unpublished ticket branch
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t6');
  commitFile(w.work, 'ticket.txt', 't\n', 'ticket work');
  advanceOrigin(w, 1, 'blocker.txt');
  fs.writeFileSync(path.join(w.work, 'blocker.txt'), 'mine\n');
  const head = git(w.work, 'rev-parse', 'HEAD');
  const s = pre(w.work, ['--sync']);
  eq('untracked blocks rebase: status', s.out.status, 'sync-failed');
  eq('untracked blocks rebase: HEAD restored', git(w.work, 'rev-parse', 'HEAD'), head);
  eq('untracked blocks rebase: still on the branch', git(w.work, 'symbolic-ref', '--short', 'HEAD'), 'trailhead/t6');
  ok('untracked blocks rebase: nothing in progress', !inProgress(w.work));
  eq('untracked blocks rebase: file preserved', fs.readFileSync(path.join(w.work, 'blocker.txt'), 'utf8'), 'mine\n');
}

// --- dirty tracked tree --------------------------------------------------------
{
  const w = mkWorld();
  advanceOrigin(w, 1);
  fs.writeFileSync(path.join(w.work, 'README.md'), 'changed\n');
  writeConfig(w.work, { preflight: { checks: ['echo should-not-run'] } });
  const head = git(w.work, 'rev-parse', 'HEAD');
  const s = pre(w.work, ['--sync']);
  eq('dirty: status', s.out.status, 'dirty');
  eq('dirty: HEAD unchanged', git(w.work, 'rev-parse', 'HEAD'), head);
  eq('dirty: edit kept', fs.readFileSync(path.join(w.work, 'README.md'), 'utf8'), 'changed\n');
  eq('dirty: checks skipped', s.out.checks, []);
  eq('dirty: checksOk false', s.out.checksOk, false);
}

// --- failed fetch: unverified, no sync, no checks ------------------------------
{
  const w = mkWorld();
  advanceOrigin(w, 2);
  eq('unverified setup: sees behind 2', pre(w.work).out.behind, 2);
  const marker = path.join(w.work, 'check-ran');
  writeConfig(w.work, { preflight: { checks: [`touch ${marker}`] } });
  git(w.work, 'remote', 'set-url', 'origin', path.join(w.origin, 'does-not-exist'));
  const head = git(w.work, 'rev-parse', 'HEAD');
  const s = pre(w.work, ['--sync']);
  eq('unverified: status', s.out.status, 'unverified');
  eq('unverified: distance from local refs', s.out.behind, 2);
  eq('unverified: HEAD unchanged', git(w.work, 'rev-parse', 'HEAD'), head);
  ok('unverified: checks did not run', !fs.existsSync(marker));
  eq('unverified: checksOk false', s.out.checksOk, false);
  ok('unverified: a warning explains', s.out.warnings.length > 0);
}

// --- --no-fetch ----------------------------------------------------------------
{
  const w = mkWorld();
  advanceOrigin(w, 2);
  const before = git(w.work, 'rev-parse', 'origin/main');
  const r = pre(w.work, ['--no-fetch']);
  eq('--no-fetch: status from local refs', r.out.status, 'current');
  eq('--no-fetch: origin/main not advanced', git(w.work, 'rev-parse', 'origin/main'), before);
}

// --- --config-root --------------------------------------------------------------
{
  const w = mkWorld();
  const ws = path.join(mktmp(), 'ws');
  git(w.work, 'worktree', 'add', '-q', '-b', 'trailhead/t7', ws);
  writeConfig(w.work, { preflight: { checks: ['pwd'] } });
  const r = pre(ws, ['--config-root', w.work]);
  eq('config-root: check from the original checkout ran', r.out.checks.length, 1);
  eq('config-root: check ran at the workspace root', r.out.checks[0].output.trim(), ws);
  const none = pre(ws);
  eq('config-root: workspace config is not consulted by default', none.out.checks, []);
}

// --- trunk detection ------------------------------------------------------------
{
  const w = mkWorld('develop');
  git(w.work, 'remote', 'set-head', 'origin', 'develop');
  eq('trunk: remote default branch', pre(w.work).out.trunk, 'develop');
  const solo = mktmp();
  git(solo, 'init', '-q', '-b', 'master');
  identify(solo);
  commitFile(solo, 'a.txt', 'a\n', 'init');
  const r = pre(solo);
  eq('trunk: falls back to master', r.out.trunk, 'master');
  eq('trunk: no remote uses the local trunk', r.out.base, 'master');
  eq('trunk: no remote is current', r.out.status, 'current');
  const none = mktmp();
  git(none, 'init', '-q', '-b', 'zzz');
  identify(none);
  commitFile(none, 'a.txt', 'a\n', 'init');
  eq('trunk: none found is skipped', pre(none).out.status, 'skipped');
  eq('trunk: --trunk wins', pre(w.work, ['--trunk', 'develop']).out.trunk, 'develop');
}
{
  const dir = mktmp();
  const r = pre(dir);
  eq('not a repo: exit 0', r.code, 0);
  eq('not a repo: error status', r.out.status, 'error');
  ok('not a repo: message', typeof r.out.message === 'string');
}

// --- project checks -------------------------------------------------------------
{
  const w = mkWorld();
  writeConfig(w.work, { preflight: { checks: ['echo hello', 'echo bad >&2; exit 3'] } });
  const r = pre(w.work);
  eq('checks: two results', r.out.checks.length, 2);
  eq('checks: pass', [r.out.checks[0].ok, r.out.checks[0].code], [true, 0]);
  eq('checks: pass output', r.out.checks[0].output.trim(), 'hello');
  eq('checks: fail', [r.out.checks[1].ok, r.out.checks[1].code], [false, 3]);
  ok('checks: stderr captured', r.out.checks[1].output.includes('bad'));
  eq('checks: command echoed', r.out.checks[1].command, 'echo bad >&2; exit 3');
  eq('checks: one failing makes checksOk false', r.out.checksOk, false);
  eq('checks: status still current', r.out.status, 'current');

  writeConfig(w.work, { 'preflight.checks': ['true'] });
  const flat = pre(w.work);
  eq('checks: flat form runs', flat.out.checks.length, 1);
  eq('checks: flat form ok', flat.out.checksOk, true);

  writeConfig(w.work, { preflight: { checks: ['true'] }, 'preflight.checks': ['false'] });
  eq('checks: nested wins over flat', pre(w.work).out.checks[0].command, 'true');

  writeConfig(w.work, { preflight: { checks: 'not-an-array' } });
  const bad = pre(w.work);
  eq('checks: invalid value runs nothing', bad.out.checks, []);
  ok('checks: invalid value named', /preflight\.checks/.test(bad.out.checksError));
  eq('checks: invalid value is not ok', bad.out.checksOk, false);
  writeConfig(w.work, { preflight: { checks: ['ok', ''] } });
  ok('checks: empty entry invalid', pre(w.work).out.checksError !== undefined);
  writeConfig(w.work, '{not json');
  ok('checks: bad JSON invalid', pre(w.work).out.checksError !== undefined);
}
{
  // project over global, as a whole value
  const w = mkWorld();
  const home = mktmp();
  fs.mkdirSync(path.join(home, 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(home, 'trailhead', 'config.json'), JSON.stringify({ preflight: { checks: ['echo global'] } }));
  const viaGlobal = run(['--repo', w.work], { env: { CLAUDE_CONFIG_DIR: home } });
  eq('checks: global applies when the project has none', viaGlobal.out.checks[0].command, 'echo global');
  writeConfig(w.work, { preflight: { checks: ['echo project'] } });
  const viaProject = run(['--repo', w.work], { env: { CLAUDE_CONFIG_DIR: home } });
  eq('checks: project wins as a whole value', viaProject.out.checks.map((c) => c.command), ['echo project']);
}
{
  // checks run after the sync, on the synced tree
  const w = mkWorld();
  advanceOrigin(w, 1);
  writeConfig(w.work, { preflight: { checks: ['test -f upstream-0.txt'] } });
  const r = pre(w.work, ['--sync']);
  eq('checks: run after the sync', [r.out.status, r.out.checks[0].ok, r.out.checksOk], ['synced', true, true]);
}

// --- git failures are errors, never a silent 0 ----------------------------------
{
  // unborn HEAD with an origin/main that has commits
  const w = mkWorld();
  const unborn = mktmp();
  git(unborn, 'init', '-q', '-b', 'main');
  git(unborn, 'remote', 'add', 'origin', w.origin);
  git(unborn, 'fetch', '-q', 'origin');
  const r = pre(unborn);
  eq('unborn HEAD: exit 0', r.code, 0);
  eq('unborn HEAD: error, never current', r.out.status, 'error');
  ok('unborn HEAD: git message reported', typeof r.out.message === 'string' && r.out.message.length > 0);
  eq('unborn HEAD: testsRequired false', r.out.testsRequired, false);
  eq('unborn HEAD: checksOk false', r.out.checksOk, false);
}
{
  // a remote-tracking ref whose history is broken (a parent object is missing)
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t8');
  const tree = git(w.work, 'rev-parse', 'HEAD^{tree}');
  const broken = execFileSync('git', ['-C', w.work, 'hash-object', '-w', '-t', 'commit', '--stdin'], {
    input: `tree ${tree}\nparent deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\n\nbroken\n`,
  }).toString().trim();
  git(w.work, 'update-ref', 'refs/remotes/origin/main', broken);
  const r = pre(w.work, ['--no-fetch']);
  eq('bad ref: error, never current', r.out.status, 'error');
  ok('bad ref: git message reported', typeof r.out.message === 'string' && r.out.message.length > 0);
  eq('bad ref: nothing synced', pre(w.work, ['--no-fetch', '--sync']).out.status, 'error');
}

// --- rebase keeps merge commits ---------------------------------------------------
{
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'trailhead/t10');
  git(w.work, 'checkout', '-q', '-b', 'side');
  commitFile(w.work, 'side.txt', 's\n', 'side work');
  git(w.work, 'checkout', '-q', 'trailhead/t10');
  commitFile(w.work, 'ticket.txt', 't\n', 'ticket work');
  git(w.work, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  advanceOrigin(w, 2);
  const s = pre(w.work, ['--sync']);
  eq('rebase-merges: branch rebased', [s.out.status, s.out.method], ['synced', 'rebase']);
  eq('rebase-merges: the --no-ff merge commit survives', git(w.work, 'rev-list', '--merges', '--count', 'origin/main..HEAD'), '1');
}
{
  const w = mkWorld();
  git(w.work, 'checkout', '-q', '-b', 'side');
  commitFile(w.work, 'side.txt', 's\n', 'side work');
  git(w.work, 'checkout', '-q', 'main');
  commitFile(w.work, 'local.txt', 'l\n', 'local unpushed');
  git(w.work, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  advanceOrigin(w, 1);
  const s = pre(w.work, ['--sync']);
  eq('rebase-merges: trunk rebased', [s.out.status, s.out.method], ['synced', 'rebase']);
  eq('rebase-merges: trunk keeps its merge commit', git(w.work, 'rev-list', '--merges', '--count', 'origin/main..HEAD'), '1');
}

// --- remotes without an origin ----------------------------------------------------
{
  const w = mkWorld();
  git(w.work, 'remote', 'rename', 'origin', 'upstream');
  const r = pre(w.work);
  eq('no origin: status unchanged', r.out.status, 'current');
  eq('no origin: measured on the local trunk', r.out.base, 'main');
  ok('no origin: a warning names the remotes', r.out.warnings.some((x) => /no remote named origin/.test(x) && x.includes('upstream')));
  const solo = mktmp();
  git(solo, 'init', '-q', '-b', 'main');
  identify(solo);
  commitFile(solo, 'a.txt', 'a\n', 'init');
  eq('no remotes at all: no warning', pre(solo).out.warnings, []);
}

// --- end to end -----------------------------------------------------------------
{
  const w = mkWorld();
  advanceOrigin(w, 4);
  writeConfig(w.work, { preflight: { checks: ['true'] } });
  const out = execFileSync('node', [scriptPath, '--repo', w.work, '--sync'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: emptyHome, HOME: '/nonexistent-home' },
  }).toString();
  const parsed = JSON.parse(out.trim());
  eq('e2e: synced', [parsed.status, parsed.pulled, parsed.method], ['synced', 4, 'ff']);
  eq('e2e: one JSON line', out.trim().split('\n').length, 1);
  let code = 0;
  try { execFileSync('node', [scriptPath], { stdio: 'ignore' }); } catch (err) { code = err.status; }
  eq('e2e: usage error exits 2', code, 2);
  ok('e2e: helper is executable', (fs.statSync(scriptPath).mode & 0o111) !== 0);
}

console.log(`base-preflight.test.js: ${passed} checks passed`);
