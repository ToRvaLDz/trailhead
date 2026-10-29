#!/usr/bin/env node
'use strict';
// trailhead checkout-find (self-contained, ships in templates/ so it reaches every
// install channel). When a checkout path a session was handed no longer exists (the
// repo moved), this finds the repo's checkout by its `origin` remote instead of a
// hand-run search of the disk. #329.
//
// Search order is an explicit precedence, not a uniqueness claim: the focused roots
// first (the parent of --cwd and of its git toplevel, and the usual code folders under
// $HOME), then $HOME itself only if they found nothing. `found` is the single match of
// the first tier that has any; a later tier is never weighed against it.
//
// Walk: breadth-first, depth-limited, one realpath-visited set (overlapping roots and
// symlink cycles never count a checkout twice), dot-dirs and node_modules skipped, a
// found checkout never descended into. A directory holding `.git` (directory or file)
// is a checkout; its origin is read with `git remote get-url origin`. A visited-dir
// cap per tier bounds the walk; hitting it sets `truncated`, and a lone match under
// truncation is reported `ambiguous`, never `found`, so the caller asks.
//
// Main checkouts (`.git` dir) and linked worktrees/submodules (`.git` file) are equal
// candidates: the remote cannot tell a moved worktree from its main checkout.
//
// CLI:
//   node trailhead-checkout-find.js --repo <[host/]owner/name> [--cwd <dir>]
//        [--roots <dir>:<dir>...] [--depth <n>]
// `--roots` replaces the default tiers with one explicit tier (tests, odd layouts).
//
// Prints exactly one JSON line on stdout (plus "truncated":true when the cap hit):
//   {"status":"found","path":"..."}
//   {"status":"ambiguous","candidates":[{"path":"...","kind":"main"|"linked"}]}
//   {"status":"none","searched":["..."]}
// Exit 0 for the three statuses, 2 on a usage error (stderr).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_DEPTH = 3;
const DEFAULT_CAP = 20000;
const CODE_DIRS = ['Git', 'git', 'src', 'code', 'Code', 'projects', 'Projects', 'dev', 'repos', 'work', 'workspace'];

// A remote URL as {host, path} (host lowercased, port kept), or null when it is not a
// network remote (a local path, empty).
function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (s === '' || s.startsWith('/') || s.startsWith('.') || s.startsWith('-')) return null;
  let host;
  let rest;
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)\/(.*)$/.exec(s);
  if (m) {
    host = m[1];
    rest = m[2];
  } else {
    // scp-like: [user@]host:path
    const n = /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(s);
    if (!n) return null;
    host = n[1];
    rest = n[2];
  }
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (host === '' || rest === '') return null;
  return { host: host.toLowerCase(), path: rest };
}

// A --repo argument: `owner/name` (any host) or `host/owner/name` (the first segment
// is a host when there are 3+ segments and it holds a dot or a colon).
function parseRepoArg(arg) {
  if (typeof arg !== 'string') return null;
  const parts = arg.trim().replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2 || parts.some((p) => p === '')) return null;
  if (parts.length >= 3 && /[.:]/.test(parts[0])) return { host: parts[0].toLowerCase(), path: parts.slice(1).join('/') };
  return { host: null, path: parts.join('/') };
}

const stripPort = (h) => h.replace(/:\d+$/, '');

// Whether a remote URL is the wanted repo. Host: case-insensitive; a wanted host with
// no port ignores the remote's port. Path: case-insensitive on github.com only.
function matches(remoteUrl, repoArg) {
  const remote = parseRemote(remoteUrl);
  const want = typeof repoArg === 'string' ? parseRepoArg(repoArg) : repoArg;
  if (remote === null || want === null) return false;
  if (want.host !== null) {
    const same = /:\d+$/.test(want.host) ? remote.host === want.host : stripPort(remote.host) === want.host;
    if (!same) return false;
  }
  if (stripPort(remote.host) === 'github.com') return remote.path.toLowerCase() === want.path.toLowerCase();
  return remote.path === want.path;
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function defaultOrigin(dir) {
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function toplevelOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout.trim() !== '' ? real(r.stdout.replace(/\n$/, '')) : null;
}

function uniqueExisting(dirs) {
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const r = d ? real(d) : null;
    if (r !== null && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

// The default tiers: focused roots, then $HOME.
function defaultTiers(cwd, home) {
  const focused = [];
  if (cwd) {
    focused.push(path.dirname(path.resolve(cwd)));
    const top = real(cwd) !== null ? toplevelOf(cwd) : null;
    if (top !== null) focused.push(path.dirname(top));
  }
  for (const n of CODE_DIRS) focused.push(path.join(home, n));
  const homeReal = real(home);
  const first = uniqueExisting(focused).filter((d) => d !== '/' && d !== homeReal);
  return [first, uniqueExisting([home])];
}

function kindOf(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory() ? 'main' : 'linked';
  } catch {
    return null; // no .git
  }
}

// One tier: breadth-first from its roots. Returns {matches, truncated}.
function walkTier(roots, repo, o, visited) {
  const matchesFound = [];
  let visitedCount = 0;
  let truncated = false;
  const queue = roots.map((r) => [r, 0]);
  for (let i = 0; i < queue.length; i++) {
    const [dir, depth] = queue[i];
    const rp = real(dir);
    if (rp === null || visited.has(rp)) continue;
    if (visitedCount >= o.cap) {
      truncated = true;
      break;
    }
    visited.add(rp);
    visitedCount++;
    const kind = kindOf(rp);
    if (kind !== null) {
      const origin = o.originOf(rp);
      if (origin && matches(origin, repo)) matchesFound.push({ path: rp, kind });
      continue;
    }
    if (depth >= o.depth) continue;
    let entries;
    try {
      entries = fs.readdirSync(rp, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = path.join(rp, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(child).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) queue.push([child, depth + 1]);
    }
  }
  return { matches: matchesFound, truncated };
}

// findCheckouts(repo, {roots, tiers, cwd, home, depth, cap, originOf}) -> result object.
// `roots` is one explicit tier; `tiers` several; neither means the defaults from cwd/home.
function findCheckouts(repo, opts = {}) {
  const o = {
    depth: Number.isInteger(opts.depth) && opts.depth >= 0 ? opts.depth : DEFAULT_DEPTH,
    cap: Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : DEFAULT_CAP,
    originOf: opts.originOf || defaultOrigin,
  };
  let tiers;
  if (Array.isArray(opts.tiers)) tiers = opts.tiers.map(uniqueExisting);
  else if (Array.isArray(opts.roots)) tiers = [uniqueExisting(opts.roots)];
  else tiers = defaultTiers(opts.cwd || null, opts.home || process.env.HOME || os.homedir());
  const visited = new Set();
  const searched = [];
  let truncated = false;
  for (const tier of tiers) {
    if (tier.length === 0) continue;
    searched.push(...tier);
    const r = walkTier(tier, repo, o, visited);
    truncated = truncated || r.truncated;
    if (r.matches.length === 0) continue;
    const candidates = r.matches.sort((a, b) => (a.path < b.path ? -1 : 1));
    const res = candidates.length === 1 && !r.truncated
      ? { status: 'found', path: candidates[0].path }
      : { status: 'ambiguous', candidates };
    return r.truncated ? { ...res, truncated: true } : res;
  }
  return truncated ? { status: 'none', searched, truncated: true } : { status: 'none', searched };
}

function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const usage = (msg) => {
    process.stderr.write(`${msg}\nusage: trailhead-checkout-find.js --repo <[host/]owner/name> [--cwd <dir>] [--roots <a:b>] [--depth <n>]\n`);
    return 2;
  };
  const repo = get('--repo');
  if (repo === null || parseRepoArg(repo) === null) return usage('--repo <[host/]owner/name> is required');
  const opts = { cwd: get('--cwd') };
  const roots = get('--roots');
  if (roots !== null) opts.roots = roots.split(':').filter((r) => r !== '');
  const depth = get('--depth');
  if (depth !== null) {
    if (!/^\d+$/.test(depth)) return usage('--depth must be a non-negative integer');
    opts.depth = Number(depth);
  }
  process.stdout.write(JSON.stringify(findCheckouts(repo, opts)) + '\n');
  return 0;
}

module.exports = { parseRemote, parseRepoArg, matches, findCheckouts };

if (require.main === module) process.exit(main(process.argv.slice(2)));
