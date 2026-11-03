#!/usr/bin/env node
'use strict';
// trailhead test run (self-contained, ships in templates/ so it reaches every
// install channel). Runs the configured test command behind a machine-wide queue
// (at most `testing.maxParallel` heavy runs at once across every session and
// worktree) and a green-result cache keyed by tree SHA + command, so the same
// code is never tested twice. #362.
//
// CLI:
//   node trailhead-test-run.js run --repo <working-root> [--config-root <project-root>]
//                                  [--kind full|targeted] [--files <a,b,...>] [--no-cache]
// --config-root defaults to --repo (a worktree never re-resolves its config).
// Config (nested {"testing": {...}} or flat "testing.full"; nested wins with a
// warning; the project file .trailhead/config.json replaces the global
// ${CLAUDE_CONFIG_DIR:-~/.claude}/trailhead/config.json key by key):
//   testing.full         string, the full-suite command
//   testing.targeted     string containing {files}, replaced by the single-quoted files
//   testing.maxParallel  positive integer, default 1
// Other testing.* keys (webapp, url) are left alone.
//
// Cache dir: $TRAILHEAD_CACHE_DIR, else ${XDG_CACHE_HOME:-~/.cache}/trailhead, with
//   results/<key>.json  green results only (key = sha256(tree NUL command NUL git common dir))
//   logs/<tree12>-<epoch>-<pid>.log
//   queue/              holder files (+ the short .gate mutex)
// Tree: HEAD^{tree} when the checkout is clean, else the tree of the working files
// (temp index), so uncommitted edits never reuse a result computed for HEAD. Not a
// git repo, or a submodule with uncommitted content: no caching for that run.
// Boundary: gitignored files (dependencies, build output), env and toolchain are
// not in the key; --no-cache forces a run.
//
// Output: one JSON line on stdout
//   {"status":"passed|failed|interrupted|unconfigured|invalid|error","exitCode","tree",
//    "command","source":"cache|run","cached","log","waitedMs","queuedBehind"?,"warnings"?,"message"?}
// Exit: 0 passed / cached / unconfigured, 1 failed, 2 usage error or invalid config,
// 3 internal error, 130/143/129 interrupted by SIGINT/SIGTERM/SIGHUP.
// Teardown covers the launched process group only; a command that escapes it
// (setsid, a daemon) is outside the guarantee.
// Test-only env: TRAILHEAD_TEST_POLL_MS (default 1000), TRAILHEAD_TEST_GRACE_MS
// (default 5000), TRAILHEAD_TEST_PAUSE_AFTER_HIT_MS, TRAILHEAD_TEST_CRASH_AT=before-go,
// TRAILHEAD_TEST_FAIL_PGID_UPDATE (inject a failure when recording the pgid).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { gitEnv } = require('./trailhead-git-env.js');

const CONFIG_REL = path.join('.trailhead', 'config.json');
const STALE_MS = 30 * 1000;
const LONG_RUNNING_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_GRACE_MS = 5000;
const KINDS = ['full', 'targeted'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errMsg = (err) => (err && err.message ? err.message : String(err));

// ---- pure layer ---------------------------------------------------------------

// POSIX single quoting.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Replaces every {files} with the quoted files joined by spaces.
const substituteFiles = (template, files) => template.split('{files}').join(files.map(shQuote).join(' '));

const cacheKey = (tree, command, commonDir) =>
  crypto.createHash('sha256').update(`${tree}\0${command}\0${commonDir}`).digest('hex');

// Picks `testing.<key>` out of a parsed config: { found, value, warning? }.
function pick(cfg, key, file) {
  const nested = isObject(cfg.testing) && has(cfg.testing, key);
  const flat = has(cfg, `testing.${key}`);
  if (!nested && !flat) return { found: false };
  const out = { found: true, value: nested ? cfg.testing[key] : cfg[`testing.${key}`] };
  if (nested && flat) out.warning = `${file} sets testing.${key} in both nested and flat form; the nested form wins`;
  return out;
}

function readFile(file, fs_) {
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'unset' };
    return { state: 'invalid', message: `cannot read ${file}: ${errMsg(err)}` };
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { state: 'invalid', message: `${file} is not valid JSON` };
  }
  if (!isObject(cfg)) return { state: 'invalid', message: `${file} is not a JSON object` };
  if (has(cfg, 'testing') && !isObject(cfg.testing)) return { state: 'invalid', message: `testing in ${file} must be an object` };
  return { state: 'ok', cfg };
}

function globalConfigPath(env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

const VALIDATORS = {
  full: (v, where) => (typeof v === 'string' && v.trim() !== '' ? null : `testing.full in ${where} must be a non-empty string`),
  targeted: (v, where) => (typeof v === 'string' && v.includes('{files}') ? null : `testing.targeted in ${where} must be a string containing {files}`),
  maxParallel: (v, where) => ((Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^[1-9]\d*$/.test(v))
    ? null : `testing.maxParallel in ${where} must be a positive integer`),
};

// Effective { full, targeted, maxParallel } (undefined when unset) or { error }.
function readConfig(configRoot, env, fs_, warnings) {
  const files = [path.join(configRoot, CONFIG_REL), globalConfigPath(env)];
  const parsed = [];
  for (const file of files) {
    const r = readFile(file, fs_);
    if (r.state === 'invalid') return { error: r.message };
    parsed.push({ file, cfg: r.state === 'ok' ? r.cfg : null });
  }
  const out = {};
  for (const key of Object.keys(VALIDATORS)) {
    for (const { file, cfg } of parsed) {
      if (!cfg) continue;
      const p = pick(cfg, key, file);
      if (!p.found) continue;
      const problem = VALIDATORS[key](p.value, file);
      if (problem) return { error: problem };
      if (p.warning) warnings.push(p.warning);
      out[key] = key === 'maxParallel' ? Number(p.value) : p.value;
      break;
    }
  }
  return out;
}

// Command prefix: nice / ionice when each is on the PATH.
function niceArgs(pathEnv, fs_ = fs) {
  const onPath = (bin) => String(pathEnv || '').split(path.delimiter).filter(Boolean).some((d) => {
    try {
      fs_.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const out = [];
  if (onPath('nice')) out.push('nice', '-n', '10');
  if (onPath('ionice')) out.push('ionice', '-c', '3');
  return out;
}

// Like niceArgs, but each present binary is probed once (`<bin> <args> true`) and
// only the ones that work are used (ionice can be denied by ioprio_set).
// Returns { args, warnings }.
function priorityPrefix(pathEnv, fs_ = fs) {
  const args = [];
  const warnings = [];
  const parts = [['nice', ['-n', '10']], ['ionice', ['-c', '3']]];
  for (const [bin, binArgs] of parts) {
    if (niceArgs(pathEnv, fs_).indexOf(bin) < 0) continue;
    const r = spawnSync(bin, [...binArgs, 'true'], { env: { ...process.env, PATH: pathEnv }, stdio: 'ignore' });
    if (r.status === 0) args.push(bin, ...binArgs);
    else warnings.push(`priority-unavailable: ${bin} is on the PATH but failed its probe, so the suite runs without it`);
  }
  return { args, warnings };
}

function parseArgs(argv) {
  if (argv[0] !== 'run') return { error: `usage: expected "run", got: ${argv[0] === undefined ? '(nothing)' : argv[0]}` };
  const out = { kind: 'full', repo: null, configRoot: null, files: null, noCache: false };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--no-cache') { out.noCache = true; continue; }
    if (!['--repo', '--config-root', '--kind', '--files'].includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const value = argv[i];
    if (flag === '--repo') out.repo = value;
    else if (flag === '--config-root') out.configRoot = value;
    else if (flag === '--kind') {
      if (!KINDS.includes(value)) return { error: `usage: --kind must be full or targeted, got: ${value}` };
      out.kind = value;
    } else {
      out.files = value.split(',').filter(Boolean);
      if (out.files.length === 0) return { error: 'usage: --files needs at least one file' };
    }
  }
  if (!out.repo) return { error: 'usage: run needs --repo' };
  if (out.kind === 'targeted' && !out.files) return { error: 'usage: --kind targeted needs --files' };
  if (out.kind === 'full' && out.files) return { error: 'usage: --files only goes with --kind targeted' };
  return out;
}

// ---- process liveness -----------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function killGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch { /* group already gone */ }
}

// SIGTERM, poll for the grace period, SIGKILL, wait until the group is gone.
async function teardownGroup(pgid, graceMs) {
  if (!groupAlive(pgid)) return;
  killGroup(pgid, 'SIGTERM');
  const step = 20;
  for (let waited = 0; groupAlive(pgid) && waited < graceMs; waited += step) await sleep(step);
  if (!groupAlive(pgid)) return;
  killGroup(pgid, 'SIGKILL');
  for (let waited = 0; groupAlive(pgid) && waited < 5000; waited += step) await sleep(step);
}

// ---- filesystem helpers ---------------------------------------------------------

const rand = () => crypto.randomBytes(4).toString('hex');

// Temp name readers ignore, then rename into place.
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${rand()}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

const rmQuiet = (file) => { try { fs.unlinkSync(file); } catch { /* already gone */ } };

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err && (err.code === 'ENOENT')) return { ok: false, missing: true };
    if (err instanceof SyntaxError) return { ok: false, corrupt: true };
    throw err;
  }
}

function ageMs(file, nowMs) {
  try { return nowMs - fs.statSync(file).mtimeMs; } catch { return 0; }
}

// ---- git: tree snapshot -----------------------------------------------------------

function git(repo, args, env, extra) {
  return execFileSync('git', ['--no-optional-locks', '-C', repo, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(env, extra), maxBuffer: 64 * 1024 * 1024 });
}

// True when a `git status --porcelain=v2` entry is a submodule with uncommitted
// content (m) or untracked files (u); a different checked-out commit (C) is
// covered by the tree.
function hasDirtySubmodule(statusText) {
  return statusText.split('\n').some((line) => {
    if (!/^[12] /.test(line)) return false;
    const sub = line.split(' ')[2] || '';
    return sub[0] === 'S' && (sub[2] === 'M' || sub[3] === 'U');
  });
}

// { tree, commonDir, dirtySubmodule }; tree null when not a git repo (or no commit yet).
function snapshotTree(repo, env) {
  let common;
  try {
    common = fs.realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env).trim());
    git(repo, ['rev-parse', '--verify', 'HEAD'], env);
  } catch {
    return { tree: null, commonDir: null, dirtySubmodule: false };
  }
  const status = git(repo, ['status', '--porcelain=v2', '--ignore-submodules=none'], env);
  const dirtySubmodule = hasDirtySubmodule(status);
  if (status.trim() === '') {
    return { tree: git(repo, ['rev-parse', 'HEAD^{tree}'], env).trim(), commonDir: common, dirtySubmodule };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-test-run-idx-'));
  try {
    const extra = { GIT_INDEX_FILE: path.join(dir, 'index') };
    // Seed the temp index from the real one so stat data is reused and
    // `git add -A` does not rehash every file; read-tree HEAD is the fallback.
    let seeded = false;
    try {
      const real = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'index'], env).trim());
      fs.copyFileSync(real, extra.GIT_INDEX_FILE);
      git(repo, ['add', '-A'], env, extra);
      seeded = true;
    } catch {
      rmQuiet(extra.GIT_INDEX_FILE);
    }
    if (!seeded) {
      git(repo, ['read-tree', 'HEAD'], env, extra);
      git(repo, ['add', '-A'], env, extra);
    }
    return { tree: git(repo, ['write-tree'], env, extra).trim(), commonDir: common, dirtySubmodule };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- cache dir, results, queue ----------------------------------------------------

function cacheDir(env) {
  if (env.TRAILHEAD_CACHE_DIR) return env.TRAILHEAD_CACHE_DIR;
  const xdg = env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache');
  return path.join(xdg, 'trailhead');
}

function readResult(dirs, key) {
  const r = readJson(path.join(dirs.results, `${key}.json`));
  if (!r.ok) return null;
  const v = r.value;
  return isObject(v) && v.exitCode === 0 && v.key === key ? v : null;
}

const HOLDER_RE = /^holder-.*\.json$/;

// Gate: born complete via link(), so it is never empty or partial.
// hooks.afterRead (test-only) runs between reading a dead gate and renaming it.
function acquireGate(dirs, nowMs, hooks = {}) {
  const gate = path.join(dirs.queue, '.gate');
  const token = rand();
  const tmp = path.join(dirs.queue, `.gate.tmp-${process.pid}-${token}`);
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, token }));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(tmp, gate);
        return { held: true, gate, token };
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
      }
      const cur = readJson(gate);
      if (cur.missing) continue;
      const seen = cur.ok && isObject(cur.value) ? cur.value : null;
      const owner = seen ? seen.pid : null;
      const dead = owner === null ? ageMs(gate, nowMs) > STALE_MS : !pidAlive(owner);
      if (!dead) return { held: false, pid: owner };
      if (hooks.afterRead) hooks.afterRead();
      // Reap a dead gate by renaming it away (atomic), then confirm what was
      // renamed is the dead gate that was read: another reaper may have swapped
      // in a live gate between the read and the rename.
      const stale = `${gate}.stale-${process.pid}-${rand()}`;
      try { fs.renameSync(gate, stale); } catch { continue; /* raced */ }
      const moved = readJson(stale);
      const same = seen
        ? moved.ok && isObject(moved.value) && moved.value.pid === seen.pid && moved.value.token === seen.token
        : !moved.ok;
      if (same) { rmQuiet(stale); continue; }
      // A live gate was displaced: put it back. EEXIST means someone else holds
      // the gate now; either way this attempt did not get it.
      const liveOwner = moved.ok && isObject(moved.value) ? moved.value.pid : null;
      try { fs.linkSync(stale, gate); } catch { /* someone else holds it */ }
      rmQuiet(stale);
      return { held: false, pid: liveOwner };
    }
    return { held: false, pid: null };
  } finally {
    rmQuiet(tmp);
  }
}

function releaseGate(g) {
  const cur = readJson(g.gate);
  if (cur.ok && isObject(cur.value) && cur.value.token === g.token) rmQuiet(g.gate);
}

// Sweeps leftover gate temps and stale-renamed gates of dead creators.
function sweepGateLeftovers(dirs) {
  for (const name of fs.readdirSync(dirs.queue)) {
    const m = /^\.gate\.(?:tmp|stale)-(\d+)-/.exec(name);
    if (m && m[1] !== String(process.pid) && !pidAlive(Number(m[1]))) rmQuiet(path.join(dirs.queue, name));
  }
}

// Live holders after reaping the dead ones. Alive = wrapper pid or process group alive.
function liveHolders(dirs, nowMs) {
  const live = [];
  for (const name of fs.readdirSync(dirs.queue)) {
    const file = path.join(dirs.queue, name);
    if (/^\.holder-.*\.tmp$/.test(name) || /^\..*\.tmp$/.test(name)) {
      if (ageMs(file, nowMs) > STALE_MS) rmQuiet(file);
      continue;
    }
    if (!HOLDER_RE.test(name)) continue;
    const r = readJson(file);
    if (r.missing) continue;
    if (!r.ok || !isObject(r.value)) {
      if (ageMs(file, nowMs) > STALE_MS) rmQuiet(file);
      else live.push({ file, limit: Infinity, key: null, pid: null });
      continue;
    }
    const h = r.value;
    if (pidAlive(h.pid) || groupAlive(h.pgid)) live.push({ ...h, file, limit: Number.isInteger(h.limit) && h.limit > 0 ? h.limit : 1 });
    else rmQuiet(file);
  }
  return live;
}

const describeHolder = (h, nowMs) => {
  const age = Date.parse(h.startedAt);
  const long = Number.isFinite(age) && nowMs - age > LONG_RUNNING_MS;
  return `queued behind ${h.command || '(unknown command)'} on ${h.repo || '?'} (tree ${String(h.tree || 'none').slice(0, 12)}), pid ${h.pid}${long ? ' [long-running]' : ''}`;
};

// One admission attempt. { admitted, holderFile } or { admitted: false, behind }.
// Total order of holders: (number, token). A holder still choosing (no number yet)
// is a late arrival and sorts after everyone; one with no stamp at all (unparseable,
// counted live) sorts first, which is the conservative side.
const rank = (h) => (Number.isFinite(h.number) ? h.number : h.choosing === true ? Infinity : -Infinity);
const holderBefore = (a, b) => {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb;
  return String(a.token || '') < String(b.token || '');
};

// Admission decision over the live holders (ours included): true when no holder
// ahead of us carries our cache key and our position is below the smallest limit
// among the holders at or ahead of us (the strictest live policy wins).
function admittedByRecount(live, mine) {
  const ahead = live.filter((h) => h.token !== mine.token && holderBefore(h, mine));
  if (mine.key && ahead.some((h) => h.key === mine.key)) return false;
  const limit = Math.min(mine.limit, ...ahead.map((h) => h.limit));
  return ahead.length < limit;
}

// Mutual exclusion does not rest on the gate (a contention optimisation that can
// fail under crash recovery) but on Lamport's bakery doorway, correct with atomic
// file writes and reads: (1) write the holder with choosing:true and no number;
// (2) read the live holders and take number = 1 + the largest number seen, then
// rewrite the holder as {number, choosing:false}; (3) wait until no other live
// holder is choosing (a dead one is reaped by the liveness rules, so a crashed
// chooser never blocks); (4) recount over (number, token) and admit only when no
// earlier holder has our cache key and our position is below the strictest limit
// at or ahead of us, else withdraw and let the caller retry with a fresh doorway.
// If B finishes its doorway before A starts its own, A's number is larger, so A
// defers; if the doorways overlap, each waits in (3) until the other has a number,
// and both then see each other with numbers and agree on (number, token).
// Hooks (test-only): forgeGate makes the gate always held, skipPrecheck skips the
// count under the gate, afterPrecheck runs before the holder write,
// afterChoosingWrite between the doorway steps 1 and 2, afterNumber after step 2.
async function tryAdmit(dirs, me, nowMs, hooks = {}, pollMs = 50) {
  fs.mkdirSync(dirs.queue, { recursive: true });
  const gate = hooks.forgeGate ? { held: true, gate: path.join(dirs.queue, '.gate'), token: 'forged' } : acquireGate(dirs, nowMs);
  if (!gate.held) return { admitted: false, behind: `queued behind the queue gate held by pid ${gate.pid === null ? '?' : gate.pid}` };
  const token = rand();
  const holderFile = path.join(dirs.queue, `holder-${process.pid}-${token}.json`);
  try {
    sweepGateLeftovers(dirs);
    const before = liveHolders(dirs, nowMs);
    if (!hooks.skipPrecheck) {
      const same = me.key ? before.find((h) => h.key === me.key) : null;
      const limit = Math.min(me.limit, ...before.map((h) => h.limit));
      if (same || before.length >= limit) {
        const blocker = same || before.slice().sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0];
        return { admitted: false, behind: describeHolder(blocker, nowMs) };
      }
    }
    if (hooks.afterPrecheck) await hooks.afterPrecheck();
    writeAtomic(holderFile, JSON.stringify({ pid: process.pid, pgid: null, limit: me.limit, key: me.key, repo: me.repo, tree: me.tree, command: me.command, startedAt: new Date(nowMs).toISOString(), choosing: true, token }));
  } finally {
    releaseGate(gate);
  }
  try {
    if (hooks.afterChoosingWrite) await hooks.afterChoosingWrite();
    const seen = liveHolders(dirs, nowMs).filter((h) => h.token !== token && Number.isFinite(h.number));
    const number = 1 + Math.max(0, ...seen.map((h) => h.number));
    updateHolder(holderFile, { number, choosing: false });
    if (hooks.afterNumber) await hooks.afterNumber();
    let live = liveHolders(dirs, nowMs);
    while (live.some((h) => h.token !== token && h.choosing === true)) {
      await sleep(pollMs);
      live = liveHolders(dirs, nowMs);
    }
    if (!admittedByRecount(live, { token, number, key: me.key, limit: me.limit })) {
      rmQuiet(holderFile);
      const ahead = live.filter((h) => h.token !== token && holderBefore(h, { token, number }));
      return { admitted: false, behind: ahead.length > 0 ? describeHolder(ahead[0], nowMs) : 'queued behind a concurrent admission (retrying)' };
    }
    return { admitted: true, holderFile };
  } catch (e) {
    rmQuiet(holderFile);
    throw e;
  }
}

function updateHolder(holderFile, patch) {
  const r = readJson(holderFile);
  const cur = r.ok && isObject(r.value) ? r.value : {};
  writeAtomic(holderFile, JSON.stringify({ ...cur, ...patch }));
}

// ---- running ------------------------------------------------------------------------

const launcherScript = (prefix) =>
  `IFS= read -r go || exit 125; [ "$go" = go ] || exit 125; exec ${prefix.concat('sh').join(' ')} -c "$TRAILHEAD_TEST_CMD" </dev/null`;

// Spawns the handshake launcher detached in its own process group. Returns
// { child, pgid, exited } where exited resolves { code, signal } when it ends.
function launch(command, repo, logFd, env, prefix) {
  const child = spawn('sh', ['-c', launcherScript(prefix)], {
    cwd: repo,
    detached: true,
    stdio: ['pipe', logFd, logFd],
    env: gitEnv(env, { TRAILHEAD_TEST_CMD: command }),
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on('error', () => { /* launcher already gone */ });
  return { child, pgid: child.pid, exited };
}

const exitCodeOf = ({ code, signal }) => (code !== null ? code : 128 + (os.constants.signals[signal] || 0));

function output(stdout, result) {
  stdout.write(JSON.stringify(result) + '\n');
}

async function main(argv, { cwd, env, stdout, stderr, now, signals = true } = {}) {
  const cwd_ = cwd || process.cwd();
  const env_ = env || process.env;
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const nowMs = () => (now ? now().getTime() : Date.now());
  const started = nowMs();

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    err.write(parsed.error + '\n');
    return 2;
  }
  const repo = path.resolve(cwd_, parsed.repo);
  const configRoot = parsed.configRoot ? path.resolve(cwd_, parsed.configRoot) : repo;
  const warnings = [];
  const base = { status: 'error', exitCode: null, tree: null, command: null, source: 'run', cached: false, log: null, waitedMs: 0 };
  const emit = (result) => {
    const final = { ...base, ...result };
    if (warnings.length > 0) final.warnings = warnings.slice();
    output(out, final);
  };

  let signalled = null;
  let activeGroup = null;
  let teardown = null;
  const graceMs = Number(env_.TRAILHEAD_TEST_GRACE_MS) || DEFAULT_GRACE_MS;
  const pollMs = Number(env_.TRAILHEAD_TEST_POLL_MS) || DEFAULT_POLL_MS;
  const handlers = {};
  if (signals) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      handlers[sig] = () => {
        signalled = signalled || sig;
        if (activeGroup !== null && !teardown) teardown = teardownGroup(activeGroup, graceMs);
      };
      process.on(sig, handlers[sig]);
    }
  }

  let holderFile = null;
  let logFd = null;
  try {
    const cfg = readConfig(configRoot, env_, fs, warnings);
    if (cfg.error) {
      emit({ status: 'invalid', message: cfg.error });
      return 2;
    }
    const template = cfg[parsed.kind];
    if (template === undefined) {
      emit({ status: 'unconfigured' });
      return 0;
    }
    const command = parsed.kind === 'targeted' ? substituteFiles(template, parsed.files) : template;
    base.command = command;
    const limit = cfg.maxParallel || 1;
    const dirs = {
      root: cacheDir(env_),
      results: path.join(cacheDir(env_), 'results'),
      logs: path.join(cacheDir(env_), 'logs'),
      queue: path.join(cacheDir(env_), 'queue'),
    };

    const snap = () => {
      const s = snapshotTree(repo, env_);
      return { ...s, key: s.tree && s.commonDir ? cacheKey(s.tree, command, s.commonDir) : null };
    };
    const cacheable = (s) => s.key !== null && !s.dirtySubmodule;
    let dirtyNoted = false;
    const noteDirty = (s) => {
      if (s.dirtySubmodule && !dirtyNoted) {
        dirtyNoted = true;
        warnings.push('dirty-submodule: a submodule has uncommitted content or untracked files, so this run is not cached');
      }
    };

    // Cache hit that is still valid: the tree is recomputed before the hit is returned.
    const lookup = async () => {
      for (;;) {
        const s = snap();
        noteDirty(s);
        if (parsed.noCache || !cacheable(s)) return { s, hit: null };
        const hit = readResult(dirs, s.key);
        if (!hit) return { s, hit: null };
        const pause = Number(env_.TRAILHEAD_TEST_PAUSE_AFTER_HIT_MS);
        if (pause > 0) await sleep(pause);
        const again = snap();
        if (again.key === s.key) return { s, hit };
      }
    };

    const cached = (s, hit) => {
      emit({ status: 'passed', exitCode: 0, tree: s.tree, command, source: 'cache', cached: true, waitedMs: nowMs() - started, log: null, ...(base.queuedBehind ? { queuedBehind: base.queuedBehind } : {}) });
      return 0;
    };
    const interrupted = (s) => {
      emit({ status: 'interrupted', signal: signalled, tree: s ? s.tree : null, command, log: base.log, waitedMs: nowMs() - started });
      return signalled === 'SIGINT' ? 130 : signalled === 'SIGHUP' ? 129 : 143;
    };
    const release = () => { if (holderFile) { rmQuiet(holderFile); holderFile = null; } };

    let s = null;
    let lastBehind = null;
    for (;;) {
      const first = await lookup();
      s = first.s;
      if (first.hit) return cached(s, first.hit);

      // Queue admission; the key can move while waiting (re-entered below).
      for (;;) {
        if (signalled) return interrupted(s);
        const adm = await tryAdmit(dirs, { key: s.key, limit, repo, tree: s.tree, command }, nowMs(), {}, pollMs);
        if (adm.admitted) { holderFile = adm.holderFile; break; }
        if (adm.behind !== lastBehind) {
          lastBehind = adm.behind;
          base.queuedBehind = adm.behind;
          err.write(adm.behind + '\n');
        }
        await sleep(pollMs);
      }

      // Recompute after acquiring: a moved key re-enters admission under the new key.
      const second = await lookup();
      if (second.s.key !== s.key) { release(); continue; }
      if (second.hit) { release(); return cached(second.s, second.hit); }
      s = second.s;
      break;
    }

    // Run through the handshake launcher.
    fs.mkdirSync(dirs.logs, { recursive: true });
    base.log = path.join(dirs.logs, `${(s.tree || 'notree').slice(0, 12)}-${Math.floor(nowMs() / 1000)}-${process.pid}.log`);
    logFd = fs.openSync(base.log, 'a');
    const prio = priorityPrefix(env_.PATH);
    warnings.push(...prio.warnings);
    const run = launch(command, repo, logFd, env_, prio.args);
    activeGroup = run.pgid;
    if (signalled) teardown = teardown || teardownGroup(run.pgid, graceMs);
    try {
      if (env_.TRAILHEAD_TEST_FAIL_PGID_UPDATE) throw new Error('injected pgid update failure');
      updateHolder(holderFile, { pgid: run.pgid });
    } catch (e) {
      // Never leave a launched suite unrecorded: close the handshake pipe (the launcher
      // exits 125 without running) and tear the group down before reporting the error.
      run.child.stdin.destroy();
      await teardownGroup(run.pgid, graceMs);
      activeGroup = null;
      throw e;
    }
    if (env_.TRAILHEAD_TEST_CRASH_AT === 'before-go') process.exit(99);
    run.child.stdin.end('go\n');

    const ended = await run.exited;
    let leftover = false;
    if (!signalled) {
      for (let i = 0; i < 3 && !leftover; i++) {
        if (!groupAlive(run.pgid)) break;
        if (i === 2) leftover = true; else await sleep(20);
      }
      if (leftover) warnings.push('leftover-processes: the command left running processes behind, so the result is not cached');
    }
    await (teardown || teardownGroup(run.pgid, graceMs));
    activeGroup = null;

    if (signalled) return interrupted(s);

    const exitCode = exitCodeOf(ended);
    const after = snap();
    const moved = after.key !== s.key;
    if (moved) warnings.push('tree-changed: the working tree changed while the command ran, so the result is not cached');
    let stored = false;
    if (exitCode === 0 && !moved && !leftover && cacheable(s)) {
      try {
        fs.mkdirSync(dirs.results, { recursive: true });
        writeAtomic(path.join(dirs.results, `${s.key}.json`), JSON.stringify({ key: s.key, tree: s.tree, command, exitCode: 0, finishedAt: new Date(nowMs()).toISOString() }));
        stored = true;
      } catch (e) {
        warnings.push(`cache-write-failed: ${errMsg(e)}`);
      }
    }
    emit({
      status: exitCode === 0 ? 'passed' : 'failed', exitCode, tree: s.tree, command, source: 'run', cached: false,
      log: base.log, waitedMs: nowMs() - started, stored,
      ...(base.queuedBehind ? { queuedBehind: base.queuedBehind } : {}),
    });
    return exitCode === 0 ? 0 : 1;
  } catch (e) {
    emit({ status: 'error', message: 'error: ' + errMsg(e) });
    return 3;
  } finally {
    if (activeGroup !== null) await teardownGroup(activeGroup, graceMs).catch(() => {});
    if (holderFile) rmQuiet(holderFile);
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* already closed */ } }
    for (const sig of Object.keys(handlers)) process.removeListener(sig, handlers[sig]);
  }
}

module.exports = {
  shQuote, substituteFiles, cacheKey, pick, readConfig, niceArgs, priorityPrefix, parseArgs, hasDirtySubmodule,
  snapshotTree, pidAlive, groupAlive, tryAdmit, liveHolders, acquireGate, releaseGate, readResult, main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stderr.write('error: ' + errMsg(e) + '\n');
    process.exit(3);
  });
}
