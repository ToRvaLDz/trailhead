#!/usr/bin/env node
// Tests for templates/trailhead-test-run.js (#362). Run: node test-run.test.js
// No framework: plain asserts, same style as isolation-answer.test.js.
//
// Layers covered:
//   1. Pure: config pick, {files} quoting, cache key, nice/ionice prefix, args.
//   2. Tree snapshot in a mkdtemp git repo (clean vs dirty).
//   3. End-to-end: the script spawned for real, with TRAILHEAD_CACHE_DIR in a
//      mkdtemp dir (never the real ~/.cache), a short poll and a short grace.
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-test-run.js');
const lib = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const tmpDirs = [];
const children = new Set();
function mktmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-test-run-test-')));
  tmpDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
}

// --- git fixtures ------------------------------------------------------------------
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];
function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'protocol.file.allow=always', '-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function mkrepo(files = { 'a.txt': 'one\n' }) {
  const dir = mktmp();
  git(dir, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

// A config root (separate from the repo, so the repo stays clean).
function mkcfg(testing, flat = false) {
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  const cfg = flat ? Object.fromEntries(Object.entries(testing).map(([k, v]) => [`testing.${k}`, v])) : { testing };
  fs.writeFileSync(path.join(dir, '.trailhead', 'config.json'), JSON.stringify(cfg));
  return dir;
}

// Records "start <label> <ms>" / "end <label> <ms>" lines around a sleep.
const recJs = path.join(mktmp(), 'rec.js');
fs.writeFileSync(recJs, `const fs = require('fs');
const [log, label, ms] = process.argv.slice(2);
fs.appendFileSync(log, 'start ' + label + ' ' + Date.now() + '\\n');
setTimeout(() => { fs.appendFileSync(log, 'end ' + label + ' ' + Date.now() + '\\n'); }, Number(ms));
`);
const rec = (log, label, ms) => `node ${recJs} ${log} ${label} ${ms}`;
const recLines = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')) : []);
const interval = (log, label) => {
  const rows = recLines(log).filter((r) => r[1] === label);
  const s = rows.find((r) => r[0] === 'start');
  const e = rows.find((r) => r[0] === 'end');
  return s && e ? { start: Number(s[2]), end: Number(e[2]) } : null;
};
const disjoint = (a, b) => a.end <= b.start || b.end <= a.start;
const starts = (log) => recLines(log).filter((r) => r[0] === 'start').length;

// --- running the helper ---------------------------------------------------------------
function baseEnv(cache, extra = {}) {
  return {
    ...process.env,
    TRAILHEAD_CACHE_DIR: cache,
    CLAUDE_CONFIG_DIR: path.join(cache, 'no-global-config'),
    TRAILHEAD_TEST_POLL_MS: '50',
    TRAILHEAD_TEST_GRACE_MS: '300',
    ...extra,
  };
}

// Starts the helper; { child, done } where done resolves { code, signal, lines, out, err }.
function start(args, env) {
  const child = spawn(process.execPath, [scriptPath, 'run', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      const lines = out.split('\n').filter(Boolean);
      resolve({ code, signal, lines, out, err, json: lines.length === 1 ? JSON.parse(lines[0]) : null });
    });
  });
  return { child, done, stderr: () => err };
}

const runHelper = (args, env) => start(args, env).done;
const resultsOf = (cache) => (fs.existsSync(path.join(cache, 'results'))
  ? fs.readdirSync(path.join(cache, 'results')).filter((n) => n.endsWith('.json')) : []);
const queueOf = (cache) => (fs.existsSync(path.join(cache, 'queue')) ? fs.readdirSync(path.join(cache, 'queue')) : []);
const holdersOf = (cache) => queueOf(cache).filter((n) => /^holder-.*\.json$/.test(n));
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

// --- 1. pure layer -----------------------------------------------------------------------
{
  const f = 'cfg.json';
  ok('pick nested', lib.pick({ testing: { full: 'x' } }, 'full', f).value === 'x');
  ok('pick flat', lib.pick({ 'testing.full': 'y' }, 'full', f).value === 'y');
  const both = lib.pick({ testing: { full: 'x' }, 'testing.full': 'y' }, 'full', f);
  ok('nested wins with a warning', both.value === 'x' && /nested form wins/.test(both.warning));
  ok('pick absent', lib.pick({ testing: { webapp: true } }, 'full', f).found === false);

  const w = [];
  const dir = mkcfg({ full: 'make test', targeted: 'make t F={files}', maxParallel: 2, webapp: true, url: 'http://x' });
  const cfg = lib.readConfig(dir, { CLAUDE_CONFIG_DIR: path.join(dir, 'nope') }, fs, w);
  ok('readConfig nested', cfg.full === 'make test' && cfg.targeted === 'make t F={files}' && cfg.maxParallel === 2);
  const flat = lib.readConfig(mkcfg({ full: 'f', maxParallel: '3' }, true), { CLAUDE_CONFIG_DIR: dir }, fs, []);
  ok('readConfig flat, numeric string', flat.full === 'f' && flat.maxParallel === 3);

  const glob = mktmp();
  fs.mkdirSync(path.join(glob, 'trailhead'));
  fs.writeFileSync(path.join(glob, 'trailhead', 'config.json'), JSON.stringify({ testing: { full: 'global-full', maxParallel: 4 } }));
  const merged = lib.readConfig(mkcfg({ full: 'project-full' }), { CLAUDE_CONFIG_DIR: glob }, fs, []);
  ok('project replaces global key by key', merged.full === 'project-full' && merged.maxParallel === 4);

  for (const [name, testing] of [['maxParallel 0', { maxParallel: 0 }], ['maxParallel text', { maxParallel: 'many' }],
    ['targeted without {files}', { targeted: 'make t' }], ['full empty', { full: ' ' }], ['full number', { full: 3 }]]) {
    ok(`invalid config: ${name}`, typeof lib.readConfig(mkcfg(testing), { CLAUDE_CONFIG_DIR: dir }, fs, []).error === 'string');
  }
  const bad = mktmp();
  fs.mkdirSync(path.join(bad, '.trailhead'));
  fs.writeFileSync(path.join(bad, '.trailhead', 'config.json'), '{nope');
  ok('invalid JSON config', /not valid JSON/.test(lib.readConfig(bad, { CLAUDE_CONFIG_DIR: dir }, fs, []).error));

  ok('shQuote plain', lib.shQuote('a b') === "'a b'");
  ok('shQuote single quote', lib.shQuote("it's") === `'it'\\''s'`);
  ok('{files} substitution', lib.substituteFiles('t {files} --x', ['a.js', "b c.js"]) === "t 'a.js' 'b c.js' --x");

  const k = lib.cacheKey('T', 'cmd', '/r/.git');
  ok('cache key is sha256 hex', /^[0-9a-f]{64}$/.test(k));
  ok('cache key varies on tree, command and repo',
    k !== lib.cacheKey('T2', 'cmd', '/r/.git') && k !== lib.cacheKey('T', 'cmd2', '/r/.git') && k !== lib.cacheKey('T', 'cmd', '/q/.git'));
  ok('cache key is stable', k === lib.cacheKey('T', 'cmd', '/r/.git'));

  const bin = mktmp();
  const empty = mktmp();
  for (const b of ['nice', 'ionice']) { fs.writeFileSync(path.join(bin, b), '#!/bin/sh\n'); fs.chmodSync(path.join(bin, b), 0o755); }
  ok('prefix with both on PATH', lib.niceArgs(bin).join(' ') === 'nice -n 10 ionice -c 3');
  ok('prefix with none on PATH', lib.niceArgs(empty).length === 0);

  // W2: each present binary is probed; a failing ionice is dropped with a warning.
  const failBin = mktmp();
  fs.writeFileSync(path.join(failBin, 'nice'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(failBin, 'ionice'), '#!/bin/sh\nexit 1\n');
  for (const b of ['nice', 'ionice']) fs.chmodSync(path.join(failBin, b), 0o755);
  const prio = lib.priorityPrefix(failBin);
  ok('probe keeps nice, drops a failing ionice', prio.args.join(' ') === 'nice -n 10');
  ok('probe warns priority-unavailable', prio.warnings.length === 1 && /^priority-unavailable: ionice/.test(prio.warnings[0]));
  const bothOk = lib.priorityPrefix(bin);
  ok('probe keeps both when they work', bothOk.args.join(" ") === "nice -n 10 ionice -c 3" && bothOk.warnings.length === 0);
  ok('probe with none on PATH', lib.priorityPrefix(empty).args.length === 0 && lib.priorityPrefix(empty).warnings.length === 0);

  ok('args: defaults', lib.parseArgs(['run', '--repo', '/r']).kind === 'full');
  ok('args: targeted needs files', /--files/.test(lib.parseArgs(['run', '--repo', '/r', '--kind', 'targeted']).error));
  ok('args: unknown flag', /unknown/.test(lib.parseArgs(['run', '--repo', '/r', '--zzz']).error));
  ok('args: no repo', /--repo/.test(lib.parseArgs(['run']).error));
  ok('args: bad verb', /expected "run"/.test(lib.parseArgs(['go']).error));
  ok('args: files split', lib.parseArgs(['run', '--repo', '/r', '--kind', 'targeted', '--files', 'a,b']).files.join('|') === 'a|b');

  ok('submodule modified content is dirty', lib.hasDirtySubmodule('1 .M SCM. 160000 160000 160000 aaa bbb sub'));
  ok('submodule untracked is dirty', lib.hasDirtySubmodule('1 .M S..U 160000 160000 160000 aaa bbb sub'));
  ok('submodule new commit only is not dirty', !lib.hasDirtySubmodule('1 .M SC.. 160000 160000 160000 aaa bbb sub'));
  ok('plain file is not a submodule', !lib.hasDirtySubmodule('1 .M N... 100644 100644 100644 aaa bbb f.txt'));
}

// --- 2. tree snapshot -----------------------------------------------------------------------
{
  const repo = mkrepo();
  const clean = lib.snapshotTree(repo, process.env);
  ok('clean tree equals HEAD^{tree}', clean.tree === git(repo, 'rev-parse', 'HEAD^{tree}'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'edited\n');
  const dirty = lib.snapshotTree(repo, process.env);
  ok('dirty tree differs from HEAD tree', dirty.tree && dirty.tree !== clean.tree);
  ok('dirty tree is stable', lib.snapshotTree(repo, process.env).tree === dirty.tree);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
  ok('untracked file changes the tree', lib.snapshotTree(repo, process.env).tree !== dirty.tree);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'second');
  ok('committing the same files lands on the same tree',
    lib.snapshotTree(repo, process.env).tree === git(repo, 'rev-parse', 'HEAD^{tree}'));
  // I1: the dirty snapshot works from the real index, in a linked worktree too.
  const wtDir = path.join(mktmp(), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'snapwt', wtDir);
  const wtClean = lib.snapshotTree(wtDir, process.env).tree;
  fs.writeFileSync(path.join(wtDir, 'a.txt'), 'worktree edit\n');
  const wtDirty = lib.snapshotTree(wtDir, process.env);
  ok('dirty snapshot in a linked worktree', wtDirty.tree && wtDirty.tree !== wtClean);
  git(wtDir, 'add', 'a.txt');
  ok('staged and unstaged edits give the same tree', lib.snapshotTree(wtDir, process.env).tree === wtDirty.tree);
  fs.rmSync(path.join(wtDir, 'a.txt'));
  ok('a deleted tracked file changes the tree', lib.snapshotTree(wtDir, process.env).tree !== wtDirty.tree);
  const plain = mktmp();
  ok('not a git repo -> tree null', lib.snapshotTree(plain, process.env).tree === null);
  ok('index of the repo untouched by snapshot', git(repo, 'status', '--porcelain') === '');
}

(async () => {
  // --- W1: a live gate swapped in after the dead-gate read is never displaced -----------------------
  {
    const q = mktmp();
    const dirs = { queue: q };
    const gate = path.join(q, '.gate');
    fs.writeFileSync(gate, JSON.stringify({ pid: deadPid(), token: 'dead' }));
    const liveText = JSON.stringify({ pid: process.pid, token: 'live' });
    const r = lib.acquireGate(dirs, Date.now(), {
      afterRead: () => {
        // Another reaper reaped the dead gate and linked its own live one.
        fs.unlinkSync(gate);
        fs.writeFileSync(gate, liveText);
      },
    });
    ok('(W1) the racing reaper does not get the gate', r.held === false && r.pid === process.pid);
    ok('(W1) the live gate is still in place, unchanged', fs.readFileSync(gate, 'utf8') === liveText);
    ok('(W1) no stale copy left behind', fs.readdirSync(q).every((n) => !n.startsWith('.gate.stale-')));
    fs.unlinkSync(gate);
    fs.writeFileSync(gate, JSON.stringify({ pid: deadPid(), token: 'dead2' }));
    const r2 = lib.acquireGate(dirs, Date.now());
    ok('(W1) an undisturbed dead gate is still reaped and taken', r2.held === true);
    lib.releaseGate(r2);
  }

  // --- (a) serialisation: maxParallel 1, two different commands ---------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfgA = mkcfg({ full: rec(log, 'A', 400) });
    const cfgB = mkcfg({ full: rec(log, 'B', 400) });
    const [ra, rb] = await Promise.all([
      runHelper(['--repo', repo, '--config-root', cfgA], baseEnv(cache)),
      runHelper(['--repo', repo, '--config-root', cfgB], baseEnv(cache)),
    ]);
    ok('(a) one JSON line each', ra.json && rb.json && ra.lines.length === 1 && rb.lines.length === 1);
    ok('(a) both passed and executed', ra.code === 0 && rb.code === 0 && ra.json.source === 'run' && rb.json.source === 'run');
    const ia = interval(log, 'A');
    const ib = interval(log, 'B');
    ok('(a) both intervals recorded', ia && ib);
    ok('(a) intervals do not overlap', disjoint(ia, ib));
    ok('(a) holders cleaned up', holdersOf(cache).length === 0);
    ok('(a) the waiting run names what it was queued behind',
      /queued behind node .* on .* \(tree [0-9a-f]{12}\), pid \d+/.test(ra.err + rb.err));
    ok('(a) log file written', ra.json.log && fs.existsSync(ra.json.log));
  }

  // --- (b) queue then cache ------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfg = mkcfg({ full: rec(log, 'X', 400) });
    const [r1, r2] = await Promise.all([
      runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache)),
      runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache)),
    ]);
    ok('(b) one JSON line each', r1.json && r2.json);
    ok('(b) command executed exactly once', starts(log) === 1);
    const sources = [r1.json.source, r2.json.source].sort();
    ok('(b) one run, one cache', sources[0] === 'cache' && sources[1] === 'run');
    const second = r1.json.source === 'cache' ? r1 : r2;
    ok('(b) cached result is cached:true and passed', second.json.cached === true && second.json.status === 'passed' && second.code === 0);
    ok('(b) the second named what it was queued behind', /queued behind .*pid \d+/.test(second.err));
    ok('(b) one result entry', resultsOf(cache).length === 1);
    const third = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(b) later run is a pure cache hit, no queue', third.json.source === 'cache' && starts(log) === 1 && !/queued/.test(third.err));
    const forced = await runHelper(['--repo', repo, '--config-root', cfg, '--no-cache'], baseEnv(cache));
    ok('(b) --no-cache forces a run', forced.json.source === 'run' && starts(log) === 2);
  }

  // --- (c) maxParallel 2 overlaps -----------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfgA = mkcfg({ full: rec(log, 'A', 1200), maxParallel: 2 });
    const cfgB = mkcfg({ full: rec(log, 'B', 1200), maxParallel: 2 });
    await Promise.all([
      runHelper(['--repo', repo, '--config-root', cfgA], baseEnv(cache)),
      runHelper(['--repo', repo, '--config-root', cfgB], baseEnv(cache)),
    ]);
    const ia = interval(log, 'A');
    const ib = interval(log, 'B');
    ok('(c) maxParallel 2: intervals overlap', ia && ib && !disjoint(ia, ib));
  }

  // --- (m) same tree + command, maxParallel 2 -> once --------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfg = mkcfg({ full: rec(log, 'X', 400), maxParallel: 2 });
    const [r1, r2] = await Promise.all([
      runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache)),
      runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache)),
    ]);
    ok('(m) executed once despite free capacity', starts(log) === 1);
    ok('(m) the second reports cache', [r1.json.source, r2.json.source].sort().join() === 'cache,run');
  }

  // --- (d) mixed limits: an N=1 run is live, an N=2 caller waits -------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfgA = mkcfg({ full: rec(log, 'A', 1000), maxParallel: 1 });
    const cfgB = mkcfg({ full: rec(log, 'B', 100), maxParallel: 2 });
    const a = start(['--repo', repo, '--config-root', cfgA], baseEnv(cache));
    ok('(d) the N=1 holder appears', await until(() => holdersOf(cache).length === 1));
    const b = start(['--repo', repo, '--config-root', cfgB], baseEnv(cache));
    const [ra, rb] = await Promise.all([a.done, b.done]);
    ok('(d) both passed', ra.code === 0 && rb.code === 0);
    ok('(d) the N=2 caller did not run beside the N=1 run', disjoint(interval(log, 'A'), interval(log, 'B')));
    ok('(d) it waited behind it', /queued behind/.test(rb.err));
  }

  // --- (e) reaping ----------------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfg = mkcfg({ full: rec(log, 'X', 50) });
    fs.mkdirSync(path.join(cache, 'queue'), { recursive: true });
    const dead = deadPid();
    const holder = path.join(cache, 'queue', 'holder-1-dead.json');
    fs.writeFileSync(holder, JSON.stringify({ pid: dead, pgid: dead, limit: 1, key: 'k', repo: '/x', tree: 't', command: 'c', startedAt: new Date().toISOString() }));
    const r = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(e) a dead holder does not block', r.code === 0 && r.json.source === 'run' && !/queued/.test(r.err));
    ok('(e) the dead holder was reaped', !fs.existsSync(holder));

    const live = path.join(cache, 'queue', 'holder-2-live.json');
    fs.writeFileSync(live, JSON.stringify({ pid: process.pid, pgid: null, limit: 1, key: 'k2', repo: '/x', tree: 't', command: 'old run', startedAt: '2000-01-01T00:00:00.000Z' }));
    const old = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(live, old, old);
    const cfg2 = mkcfg({ full: rec(log, 'Y', 50) });
    const h = start(['--repo', repo, '--config-root', cfg2], baseEnv(cache));
    await sleep(700);
    ok('(e) a live pid is never reaped, whatever its age', fs.existsSync(live) && h.child.exitCode === null);
    ok('(e) the note says it is long-running', /long-running/.test(h.stderr()));
    fs.unlinkSync(live);
    const done = await h.done;
    ok('(e) it runs once the holder is gone', done.code === 0 && done.json.source === 'run');
  }

  // --- (f) leftover processes -----------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const pidFile = path.join(mktmp(), 'pid');
    const cfg = mkcfg({ full: `sleep 30 & echo $! > ${pidFile}` });
    const r = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    ok('(f) exit code kept', r.code === 0 && r.json.status === 'passed');
    ok('(f) leftover-processes warning', (r.json.warnings || []).some((w) => /^leftover-processes/.test(w)));
    ok('(f) no live descendant after the helper returns', await until(() => !lib.pidAlive(pid) || spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z'), 3000));
    ok('(f) not cached', resultsOf(cache).length === 0);
  }

  // --- (g) failed run -----------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfg = mkcfg({ full: `echo x >> ${log}; exit 3` });
    const r1 = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(g) failed: status failed, exit 1, command code reported', r1.code === 1 && r1.json.status === 'failed' && r1.json.exitCode === 3);
    const r2 = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(g) a failure is not cached: it runs again', r2.json.source === 'run' && fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length === 2);
    ok('(g) no result entry', resultsOf(cache).length === 0);
  }

  // --- (h) dirty tree has a different key ----------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfg = mkcfg({ full: rec(log, 'X', 50) });
    const r1 = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted\n');
    const r2 = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(h) uncommitted edit does not reuse the HEAD result', r2.json.source === 'run' && r2.json.tree !== r1.json.tree && starts(log) === 2);
    const r3 = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(h) the dirty tree is cached under its own key', r3.json.source === 'cache' && r3.json.tree === r2.json.tree && starts(log) === 2);
  }

  // --- (i) internal error ----------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cacheFile = path.join(mktmp(), 'a-file');
    fs.writeFileSync(cacheFile, 'not a dir');
    const cfg = mkcfg({ full: 'true' });
    const r = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cacheFile, { CLAUDE_CONFIG_DIR: mktmp() }));
    ok('(i) internal error: status error, exit 3, message', r.code === 3 && r.json && r.json.status === 'error' && /error/.test(r.json.message));
  }

  // --- usage / unconfigured / invalid ------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const u = await runHelper([], baseEnv(cache));
    ok('usage error: exit 2, nothing on stdout', u.code === 2 && u.out === '');
    const none = await runHelper(['--repo', repo, '--config-root', mktmp()], baseEnv(cache));
    ok('unconfigured: exit 0 and status', none.code === 0 && none.json.status === 'unconfigured');
    const inv = await runHelper(['--repo', repo, '--config-root', mkcfg({ full: 'true', maxParallel: 0 })], baseEnv(cache));
    ok('invalid config: exit 2, status invalid', inv.code === 2 && inv.json.status === 'invalid');
    const log = path.join(mktmp(), 'log');
    const tcfg = mkcfg({ targeted: `echo {files} >> ${log}` });
    const t = await runHelper(['--repo', repo, '--config-root', tcfg, '--kind', 'targeted', '--files', "it's.js,b.js"], baseEnv(cache));
    ok('targeted run substitutes quoted files', t.code === 0 && fs.readFileSync(log, 'utf8').trim() === "it's.js b.js");
    const noFull = await runHelper(['--repo', repo, '--config-root', tcfg], baseEnv(cache));
    ok('full unconfigured while targeted is set', noFull.json.status === 'unconfigured');
  }

  // --- (n) leftover gate temp ----------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const cfg = mkcfg({ full: 'true' });
    fs.mkdirSync(path.join(cache, 'queue'), { recursive: true });
    const leftover = path.join(cache, 'queue', `.gate.tmp-${deadPid()}-abcd`);
    fs.writeFileSync(leftover, '{"pid":');
    const r = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(n) a leftover gate temp does not block', r.code === 0 && r.json.status === 'passed');
    ok('(n) and is swept', !fs.existsSync(leftover));
  }

  // --- (o) file edited while the command runs --------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const cfg = mkcfg({ full: `echo more >> ${path.join(repo, 'a.txt')}` });
    const r = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(o) exit 0 but tree-changed warning', r.code === 0 && (r.json.warnings || []).some((w) => /^tree-changed/.test(w)));
    ok('(o) nothing cached', resultsOf(cache).length === 0);
  }

  // --- (p) file edited while queued ---------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfgA = mkcfg({ full: rec(log, 'A', 900) });
    const cfgB = mkcfg({ full: rec(log, 'B', 50) });
    const a = start(['--repo', repo, '--config-root', cfgA], baseEnv(cache));
    ok('(p) A holds the slot', await until(() => holdersOf(cache).length === 1));
    const b = start(['--repo', repo, '--config-root', cfgB], baseEnv(cache));
    ok('(p) B is queued', await until(() => /queued behind/.test(b.stderr())));
    const before = lib.snapshotTree(repo, process.env).tree;
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edited while queued\n');
    const expected = lib.snapshotTree(repo, process.env).tree;
    const [, rb] = await Promise.all([a.done, b.done]);
    ok('(p) B keys on the new tree', rb.json.tree === expected && expected !== before && rb.code === 0);
  }

  // --- (s) file edited between a cache hit and its return -----------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfg = mkcfg({ full: rec(log, 'X', 50) });
    const first = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    const h = start(['--repo', repo, '--config-root', cfg], baseEnv(cache, { TRAILHEAD_TEST_PAUSE_AFTER_HIT_MS: '1500' }));
    await sleep(500);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edited during the hit\n');
    const r = await h.done;
    ok('(s) the stale hit is not returned', r.json.source === 'run' && r.json.tree !== first.json.tree && starts(log) === 2);
  }

  // --- (r) two linked worktrees of one repo ------------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const wt = path.join(mktmp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'wtb', wt);
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    // The config lives in the main checkout (committed so the tree stays clean).
    fs.mkdirSync(path.join(repo, '.trailhead'));
    fs.writeFileSync(path.join(repo, '.trailhead', 'config.json'), JSON.stringify({ testing: { full: rec(log, 'W', 500) } }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'config');
    git(wt, 'merge', '-q', 'main');
    const [r1, r2] = await Promise.all([
      runHelper(['--repo', repo, '--config-root', repo], baseEnv(cache)),
      runHelper(['--repo', wt, '--config-root', repo], baseEnv(cache)),
    ]);
    ok('(r) same commit in two worktrees: executed once', starts(log) === 1);
    ok('(r) the other worktree reports cache', [r1.json.source, r2.json.source].sort().join() === 'cache,run');

    fs.writeFileSync(path.join(wt, 'b.txt'), 'only in wt\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'diverge');
    const cache2 = mktmp();
    const log2 = path.join(mktmp(), 'log');
    // Same command text as before, a fresh log: rewrite via config would dirty the tree, so reuse the file.
    fs.writeFileSync(log2, '');
    const [d1, d2] = await Promise.all([
      runHelper(['--repo', repo, '--config-root', repo], baseEnv(cache2)),
      runHelper(['--repo', wt, '--config-root', repo], baseEnv(cache2)),
    ]);
    const rows = recLines(log).slice(2);
    ok('(r) different commits: both executed', d1.json.source === 'run' && d2.json.source === 'run');
    const s = rows.filter((x) => x[0] === 'start').map((x) => Number(x[2]));
    const e = rows.filter((x) => x[0] === 'end').map((x) => Number(x[2]));
    ok('(r) different commits: intervals do not overlap', s.length === 2 && e.length === 2 && (Math.max(...s) >= Math.min(...e)));
  }

  // --- (q) dirty submodules -------------------------------------------------------------------------------------------------
  {
    const mkSuper = (withNested) => {
      const src = mkrepo({ 's.txt': 's\n' });
      if (withNested) {
        const inner = mkrepo({ 'i.txt': 'i\n' });
        git(src, 'submodule', 'add', '-q', inner, 'inner');
        git(src, 'commit', '-qm', 'inner');
      }
      const sup = mkrepo({ 'a.txt': 'a\n' });
      git(sup, 'submodule', 'add', '-q', src, 'sub');
      git(sup, 'commit', '-qm', 'sub');
      if (withNested) git(sup, 'submodule', 'update', '--init', '--recursive', '-q');
      return sup;
    };
    const scenarios = [
      ['uncommitted edit', (sup) => fs.writeFileSync(path.join(sup, 'sub', 's.txt'), 'edited\n'), true],
      ['untracked file', (sup) => fs.writeFileSync(path.join(sup, 'sub', 'new.txt'), 'new\n'), true],
      ['nested dirty submodule', (sup) => fs.writeFileSync(path.join(sup, 'sub', 'inner', 'i.txt'), 'edited\n'), true, true],
      ['hidden by submodule.<name>.ignore=all', (sup) => { git(sup, 'config', 'submodule.sub.ignore', 'all'); fs.writeFileSync(path.join(sup, 'sub', 's.txt'), 'edited\n'); }, true],
    ];
    for (const [name, mutate, , nested] of scenarios) {
      const sup = mkSuper(!!nested);
      mutate(sup);
      const cache = mktmp();
      const log = path.join(mktmp(), 'log');
      const cfg = mkcfg({ full: rec(log, 'Q', 50) });
      const r1 = await runHelper(['--repo', sup, '--config-root', cfg], baseEnv(cache));
      const r2 = await runHelper(['--repo', sup, '--config-root', cfg], baseEnv(cache));
      ok(`(q) ${name}: runs, dirty-submodule warning`, r1.code === 0 && r1.json.source === 'run' && (r1.json.warnings || []).some((w) => /^dirty-submodule/.test(w)));
      ok(`(q) ${name}: nothing cached, runs again`, resultsOf(cache).length === 0 && r2.json.source === 'run' && starts(log) === 2);
    }
    // A submodule at a different commit is covered by the tree.
    const sup = mkSuper(false);
    const cache = mktmp();
    const log = path.join(mktmp(), 'log');
    const cfg = mkcfg({ full: rec(log, 'Q', 50) });
    const base = await runHelper(['--repo', sup, '--config-root', cfg], baseEnv(cache));
    fs.writeFileSync(path.join(sup, 'sub', 's.txt'), 'moved\n');
    git(path.join(sup, 'sub'), 'commit', '-qam', 'move');
    const moved = await runHelper(['--repo', sup, '--config-root', cfg], baseEnv(cache));
    ok('(q) a submodule at another commit changes the tree and is cacheable',
      moved.json.tree !== base.json.tree && !(moved.json.warnings || []).length && resultsOf(cache).length === 2);
  }

  // --- (k) crash between spawn and go ------------------------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const marker = path.join(mktmp(), 'marker');
    const cfg = mkcfg({ full: `touch ${marker}; sleep 30` });
    const r = await runHelper(['--repo', repo, '--config-root', cfg], baseEnv(cache, { TRAILHEAD_TEST_CRASH_AT: 'before-go' }));
    ok('(k) the wrapper crashed', r.code === 99);
    const holders = holdersOf(cache);
    const pgid = holders.length === 1 ? JSON.parse(fs.readFileSync(path.join(cache, 'queue', holders[0]), 'utf8')).pgid : null;
    ok('(k) the group was recorded before go', Number.isInteger(pgid));
    ok('(k) the launcher group dies without running anything', await until(() => !lib.groupAlive(pgid), 5000));
    ok('(k) the command never ran', !fs.existsSync(marker));
    // The orphaned holder is now dead and is reaped by the next run.
    const r2 = await runHelper(['--repo', repo, '--config-root', mkcfg({ full: 'true' })], baseEnv(cache));
    ok('(k) the next run reaps it and passes', r2.code === 0 && holdersOf(cache).length === 0);
  }

  // --- (l) a live gate is never taken ---------------------------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const cfg = mkcfg({ full: 'true' });
    fs.mkdirSync(path.join(cache, 'queue'), { recursive: true });
    const gate = path.join(cache, 'queue', '.gate');
    const content = JSON.stringify({ pid: process.pid, token: 'mine' });
    fs.writeFileSync(gate, content);
    const old = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(gate, old, old);
    const h = start(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    await sleep(700);
    ok('(l) the helper waits on a live gate, however old', h.child.exitCode === null && fs.readFileSync(gate, 'utf8') === content);
    ok('(l) and says why', /queue gate held by pid/.test(h.stderr()));
    fs.unlinkSync(gate);
    const r = await h.done;
    ok('(l) it goes once the gate is gone', r.code === 0);
    // A dead gate is reaped.
    fs.writeFileSync(gate, JSON.stringify({ pid: deadPid(), token: 'x' }));
    const r2 = await runHelper(['--repo', repo, '--config-root', mkcfg({ full: 'true && true' })], baseEnv(cache));
    ok('(l) a gate with a dead pid is reaped', r2.code === 0);
  }

  // --- (j) SIGTERM to the wrapper -------------------------------------------------------------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const pidFile = path.join(mktmp(), 'pid');
    const cfg = mkcfg({ full: `trap '' TERM; echo $$ > ${pidFile}; sleep 60` });
    const h = start(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(j) the command is running', await until(() => fs.existsSync(pidFile) && holdersOf(cache).length === 1));
    await sleep(100);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    h.child.kill('SIGTERM');
    const r = await h.done;
    ok('(j) exit 143 and one interrupted line', r.code === 143 && r.json && r.json.status === 'interrupted' && r.json.signal === 'SIGTERM');
    ok('(j) the TERM-ignoring descendant was killed', await until(() => !lib.pidAlive(pid), 3000));
    ok('(j) the holder is gone and nothing cached', holdersOf(cache).length === 0 && resultsOf(cache).length === 0);
  }

  // --- I2: SIGHUP gets the same teardown, exit 129 ---------------------------------------------------
  {
    const repo = mkrepo();
    const cache = mktmp();
    const pidFile = path.join(mktmp(), 'pid');
    const cfg = mkcfg({ full: `echo $$ > ${pidFile}; sleep 60` });
    const h = start(['--repo', repo, '--config-root', cfg], baseEnv(cache));
    ok('(I2) the command is running', await until(() => fs.existsSync(pidFile) && holdersOf(cache).length === 1));
    await sleep(100);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    h.child.kill('SIGHUP');
    const r = await h.done;
    ok('(I2) exit 129 and interrupted', r.code === 129 && r.json && r.json.status === 'interrupted' && r.json.signal === 'SIGHUP');
    ok('(I2) the command was torn down, holder gone', await until(() => !lib.pidAlive(pid), 3000) && holdersOf(cache).length === 0);
  }

  // cleanup
  for (const c of children) c.kill('SIGKILL');
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`test-run.test.js: ${passed} checks passed`);
})().catch((e) => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
