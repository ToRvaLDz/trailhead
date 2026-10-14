#!/usr/bin/env node
'use strict';
// trailhead base preflight (self-contained, ships in templates/ so it reaches every
// install channel: bin/trailhead.js copies templates/ wholesale for Claude/npm
// and Codex). Measures how far the working base is behind the trunk, optionally
// syncs it, and runs the project's own preflight checks. #243.
//
// CLI:
//   node trailhead-base-preflight.js --repo <working-root> [--config-root <project-root>]
//        [--trunk <name>] [--sync] [--no-fetch]
// --config-root is the original checkout the effective config was loaded from
// (defaults to --repo); a worktree/clone workspace never re-resolves config.
//
// Trunk: --trunk, else the remote default branch (refs/remotes/origin/HEAD), else
// the first existing of main / master; none found -> status skipped.
// Fetch: an explicit destination refspec so origin/<trunk> really advances. A
// failed fetch is never tolerated silently: status unverified (distance on local refs).
// Base (one ref, deterministic): no remote ref -> local <trunk>; HEAD is the trunk ->
// origin/<trunk>; HEAD on a ticket branch -> origin/<trunk> unless the local trunk is
// strictly ahead (then the local trunk); both moved -> status trunk-diverged.
// Sync (--sync, only when behind): refuses a dirty tracked tree (dirty); on the trunk
// ff-only (rebase --rebase-merges when it has diverged, merge commits are kept); on a ticket branch rebase when unpublished,
// merge when it has an upstream. Any failed sync is aborted and HEAD verified back at
// its pre-sync commit: conflict (paths listed) or sync-failed (git's message).
// Checks: `preflight.checks` (array of shell commands), nested ({"preflight":
// {"checks":[...]}}) or flat ({"preflight.checks":[...]}); nested wins when a file
// carries both. The project file (read from --config-root) wins over the global one
// (${CLAUDE_CONFIG_DIR:-~/.claude}/trailhead/config.json) as a whole value. Each
// command runs with `sh -c` at --repo after any sync. Not run on unverified,
// trunk-diverged, error, conflict, dirty, sync-failed.
// Prints one JSON line:
//   {"status","trunk","base","behind","ahead","method"?,"pulled"?,"testsRequired",
//    "conflicts":[],"checks":[{command,ok,code,output}],"checksOk","checksError"?,"warnings":[],"message"?}
//   status: current | behind | synced | unverified | trunk-diverged | dirty | conflict |
//           sync-failed | error | skipped
// Fail closed: only current and synced (with checksOk) let the caller go on.
// Exit 0 whenever a JSON line is printed; exit 2 only on a usage error.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_REL = path.join('.trailhead', 'config.json');
const CHECK_TIMEOUT_MS = 300000;
const OUTPUT_TAIL = 2000;
const FLAGS = ['sync', 'no-fetch'];
const VALUED = ['repo', 'config-root', 'trunk'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (name && VALUED.includes(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `usage: ${a} needs a value` };
      out[name] = v;
    } else if (name && FLAGS.includes(name)) {
      out[name] = true;
    } else {
      return { error: `usage: unknown argument ${a}` };
    }
  }
  if (!out.repo) return { error: 'usage: missing --repo <working-root>' };
  return out;
}

// Reads preflight.checks out of one config file.
// { state: 'unset' } | { state: 'set', list, warnings } | { state: 'invalid', message }
function readChecks(file, fs_) {
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'unset' };
    return { state: 'invalid', message: `cannot read ${file}: ${err && err.message ? err.message : err}` };
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { state: 'invalid', message: `${file} is not valid JSON` };
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { state: 'invalid', message: `${file} is not a JSON object` };
  }
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const nested = cfg.preflight !== null && typeof cfg.preflight === 'object' && !Array.isArray(cfg.preflight) && has(cfg.preflight, 'checks');
  const flat = has(cfg, 'preflight.checks');
  if (!nested && !flat) return { state: 'unset' };
  const warnings = [];
  if (nested && flat) warnings.push(`${file} sets preflight.checks in both nested and flat form; the nested form wins`);
  const value = nested ? cfg.preflight.checks : cfg['preflight.checks'];
  if (!Array.isArray(value)) return { state: 'invalid', message: `preflight.checks in ${file} must be an array of shell commands` };
  if (value.some((e) => typeof e !== 'string' || e.trim() === '')) {
    return { state: 'invalid', message: `preflight.checks in ${file} must hold only non-empty strings` };
  }
  return { state: 'set', list: value, warnings };
}

function globalConfigPath(env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

function tail(text) {
  const t = String(text || '');
  return t.length > OUTPUT_TAIL ? '...' + t.slice(t.length - OUTPUT_TAIL) : t;
}

// Runs git at `repo`; never throws on a non-zero exit.
function makeGit(repo, env) {
  const gitEnv = { ...process.env, ...env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };
  const G = (args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    const res = { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
    G.last = res;
    return res;
  };
  return G;
}

function detectTrunk(requested, G) {
  if (requested) return requested;
  const head = G(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.startsWith('origin/')) return head.out.slice('origin/'.length);
  for (const name of ['main', 'master']) {
    if (G(['show-ref', '--verify', '-q', `refs/heads/${name}`]).ok || G(['show-ref', '--verify', '-q', `refs/remotes/origin/${name}`]).ok) return name;
  }
  return null;
}

// Commit count of a range; null when git fails (the caller reports the error, never a 0).
const count = (G, range) => {
  const r = G(['rev-list', '--count', range]);
  const n = Number(r.out);
  return r.ok && r.out !== '' && Number.isInteger(n) ? n : null;
};

const gitFailure = (G, what) => `${what}: ${(G.last && (G.last.err || G.last.out)) || 'git failed'}`;

// Picks the one base ref. { base, diverged } or { error } when a comparison fails.
function pickBase(G, trunk, head, hasLocal, hasRemote) {
  const remote = `origin/${trunk}`;
  if (!hasRemote) return { base: trunk, diverged: false };
  if (!hasLocal || head === trunk) return { base: remote, diverged: false };
  const localBehind = count(G, `${trunk}..${remote}`);
  const localAhead = count(G, `${remote}..${trunk}`);
  if (localBehind === null || localAhead === null) return { error: gitFailure(G, `cannot compare ${trunk} with ${remote}`) };
  if (localBehind > 0 && localAhead > 0) return { base: remote, diverged: true };
  return { base: localAhead > 0 ? trunk : remote, diverged: false };
}

// Puts HEAD and the tree back at `pre` after a failed sync.
function restore(G, pre, warnings) {
  G(['rebase', '--abort']);
  G(['merge', '--abort']);
  if (G(['rev-parse', 'HEAD']).out !== pre) {
    G(['reset', '--hard', pre]);
    warnings.push('the failed sync left HEAD moved; it was reset to the pre-sync commit');
  }
  const back = G(['rev-parse', 'HEAD']).out === pre && G(['status', '--porcelain', '--untracked-files=no']).out === '';
  if (!back) warnings.push('could not verify the tree is back at its pre-sync state; inspect it before going on');
}

// Syncs the working base onto `base`. Returns fields for the result.
function sync(G, { trunk, head, base, ahead, behind, warnings }) {
  if (G(['status', '--porcelain', '--untracked-files=no']).out !== '') {
    return { status: 'dirty', message: 'tracked changes in the working tree; commit or stash them before syncing' };
  }
  if (!head) return { status: 'sync-failed', message: 'detached HEAD: nothing to sync' };
  const pre = G(['rev-parse', 'HEAD']).out;
  let method;
  let r;
  if (head === trunk) {
    method = ahead === 0 ? 'ff' : 'rebase';
    r = method === 'ff' ? G(['merge', '--ff-only', '-q', base]) : G(['rebase', '-q', '--rebase-merges', base]);
  } else if (G(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).ok) {
    method = 'merge';
    r = G(['merge', '--no-edit', '-q', base]);
  } else {
    method = 'rebase';
    r = G(['rebase', '-q', '--rebase-merges', base]);
  }
  if (r.ok) return { status: 'synced', method, pulled: behind, testsRequired: true };
  const conflicts = G(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  restore(G, pre, warnings);
  if (conflicts.length > 0) return { status: 'conflict', method, conflicts, message: `${method} onto ${base} conflicts; aborted, the tree is unchanged` };
  return { status: 'sync-failed', method, message: r.err || r.out || `${method} failed` };
}

function runChecks(list, repo, env) {
  const results = list.map((command) => {
    const r = spawnSync('sh', ['-c', command], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env }, timeout: CHECK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    const output = (r.stdout || '') + (r.stderr || '') + (timedOut ? `\n(timed out after ${CHECK_TIMEOUT_MS / 1000}s)` : r.error && !timedOut ? `\n${r.error.message}` : '');
    return { command, ok: r.status === 0, code: r.status, output: tail(output) };
  });
  return results;
}

const NO_CHECKS = new Set(['unverified', 'trunk-diverged', 'error', 'skipped', 'conflict', 'dirty', 'sync-failed']);

function preflight(parsed, cwd, env, fs_) {
  const repo = path.resolve(cwd, parsed.repo);
  const configRoot = path.resolve(cwd, parsed['config-root'] || parsed.repo);
  const G = makeGit(repo, env);
  const warnings = [];
  const result = { status: 'error', trunk: null, base: null, behind: 0, ahead: 0, testsRequired: false, conflicts: [], checks: [], checksOk: false, warnings };

  if (!G(['rev-parse', '--git-dir']).ok) return { ...result, message: `${repo} is not a git repository` };
  const trunk = detectTrunk(parsed.trunk, G);
  if (!trunk) return { ...result, status: 'skipped', message: 'no trunk found (no remote default branch, main or master)' };
  result.trunk = trunk;

  let fetchFailed = false;
  const hasOrigin = G(['remote', 'get-url', 'origin']).ok;
  if (!hasOrigin) {
    const remotes = G(['remote']).out.split('\n').filter(Boolean);
    if (remotes.length > 0) warnings.push(`no remote named origin (found: ${remotes.join(', ')}); distance measured on local refs`);
  }
  if (hasOrigin && !parsed['no-fetch']) {
    const f = G(['fetch', '--quiet', 'origin', `+refs/heads/${trunk}:refs/remotes/origin/${trunk}`]);
    if (!f.ok) {
      fetchFailed = true;
      warnings.push(`fetch of origin/${trunk} failed, distance measured on local refs: ${f.err || 'unknown error'}`);
    }
  }
  if (parsed['no-fetch']) warnings.push('--no-fetch: distance measured on local refs');

  const hasLocal = G(['show-ref', '--verify', '-q', `refs/heads/${trunk}`]).ok;
  const hasRemote = G(['show-ref', '--verify', '-q', `refs/remotes/origin/${trunk}`]).ok;
  if (!hasLocal && !hasRemote) return { ...result, status: 'skipped', message: `trunk ${trunk} has no local or remote ref` };
  const headName = G(['symbolic-ref', '-q', '--short', 'HEAD']);
  const head = headName.ok ? headName.out : null;
  const picked = pickBase(G, trunk, head, hasLocal, hasRemote);
  if (picked.error) return { ...result, message: picked.error };
  result.base = picked.base;
  const behind = count(G, `HEAD..${picked.base}`);
  const ahead = behind === null ? null : count(G, `${picked.base}..HEAD`);
  if (behind === null || ahead === null) return { ...result, message: gitFailure(G, `cannot measure HEAD against ${picked.base}`) };
  result.behind = behind;
  result.ahead = ahead;
  result.status = fetchFailed ? 'unverified' : picked.diverged ? 'trunk-diverged' : result.behind > 0 ? 'behind' : 'current';
  if (fetchFailed) result.message = `could not fetch origin/${trunk}; the distance is not verified`;
  if (picked.diverged) result.message = `local ${trunk} and origin/${trunk} have diverged; reconcile the trunk first`;

  if (parsed.sync && result.status === 'behind') {
    const s = sync(G, { trunk, head, base: picked.base, ahead: result.ahead, behind: result.behind, warnings });
    Object.assign(result, s);
    if (s.status === 'synced') {
      result.behind = count(G, `HEAD..${picked.base}`) ?? 0;
      result.ahead = count(G, `${picked.base}..HEAD`) ?? 0;
    }
  }

  if (!NO_CHECKS.has(result.status)) {
    let cfg = readChecks(path.join(configRoot, CONFIG_REL), fs_);
    if (cfg.state === 'unset') cfg = readChecks(globalConfigPath(env), fs_);
    if (cfg.state === 'invalid') {
      result.checksError = cfg.message;
    } else {
      if (cfg.state === 'set') {
        warnings.push(...cfg.warnings);
        result.checks = runChecks(cfg.list, repo, env);
      }
      result.checksOk = result.checks.every((c) => c.ok);
    }
  }
  return result;
}

function main(argv, { cwd, stdout, env, fs: fsMod } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const env_ = env || process.env;
  const fs_ = fsMod || fs;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }
  let result;
  try {
    result = preflight(parsed, cwd_, env_, fs_);
  } catch (err) {
    result = { status: 'error', trunk: null, base: null, behind: 0, ahead: 0, testsRequired: false, conflicts: [], checks: [], checksOk: false, warnings: [], message: 'error: ' + (err && err.message ? err.message : String(err)) };
  }
  out.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { parseArgs, readChecks, main };

if (require.main === module) {
  const code = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, env: process.env });
  process.exit(code);
}
