#!/usr/bin/env node
'use strict';
// trailhead checkout-in (self-contained, ships in templates/ so it reaches every
// install channel). The panel cannot move the session's directory, so it hands the
// pinned checkout to `work` / `resume` as a trailing `--in=<token>` word and the
// verb moves there first. This helper decodes the token, validates it and says
// whether the session is already there. It fails closed: never a blind search for
// another checkout, only a lookup by the repo's origin remote when the path is gone
// and the token names the repo (trailhead-checkout-find.js). #312, #329.
//
// The token is base64url(path) (alphabet [A-Za-z0-9_-], no padding), so a path
// with spaces, quotes or a leading `-` travels as one shell-safe word. It may carry
// the repo identity as a second part: base64url(path) + '.' + base64url(host/owner/name)
// (`.` is outside the alphabet, so an old helper rejects it and stays fail-closed).
//
// CLI:
//   node trailhead-checkout-in.js --in <token> --cwd <dir> [--roots <a:b>]
// `--roots` replaces the default search roots of the remote lookup (tests).
//
// Prints exactly one JSON line on stdout:
//   {"status":"here"|"move"|"choose"|"invalid","path":"...","reason":"...","cd":"..."}
// `cd` is present on `move` only: a ready-to-run, single-quote-escaped command.
// `relocatedFrom` (the old path) is added to `here`/`move` when the checkout was
// found by its remote. `choose` (path gone, several checkouts match) carries
// `candidates` ([{path, kind}]) and `reason`.
// Exit 0 for the four statuses, 2 on a usage error (stderr).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { findCheckouts, parseRepoArg } = require('./trailhead-checkout-find.js');

const PREFIX = '--in=';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');

function encodeIn(p, repo) {
  return PREFIX + b64(p) + (repo ? '.' + b64(repo) : '');
}

// One base64url part back to its string, or null when it is not canonical.
function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
  const s = Buffer.from(part, 'base64url').toString('utf8');
  // Round-trip guard: a part that does not re-encode to itself is not ours.
  return s !== '' && b64(s) === part ? s : null;
}

// {path, repo} (repo null for a one-part token), or null for a malformed token.
function decodeIn(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length > 2) return null;
  const p = decodePart(parts[0]);
  if (p === null) return null;
  if (parts.length === 1) return { path: p, repo: null };
  const repo = decodePart(parts[1]);
  // The repo part is `host/owner/name`: a bare `owner/name` is not what the mod hands over.
  if (repo === null || parseRepoArg(repo) === null || parseRepoArg(repo).host === null) return null;
  return { path: p, repo };
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function toplevelOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const top = r.stdout.replace(/\n$/, '');
  return top === '' ? null : real(top);
}

// POSIX single-quote escaping: ' becomes '\''.
function cdCommand(p) {
  return `cd -- '${p.replace(/'/g, `'\\''`)}'`;
}

// here/move for a path that must be a checkout root.
function resolveRoot(p, canon, cwd) {
  // The path must be a checkout root itself, never a folder inside one.
  if (toplevelOf(p) !== canon) return { status: 'invalid', path: p, reason: 'the path is not the root of a git checkout' };
  const here = real(cwd) !== null ? toplevelOf(cwd) : null;
  if (here === canon) return { status: 'here', path: p };
  return { status: 'move', path: p, cd: cdCommand(p) };
}

// The path is gone: look the repo up by its remote (only when the token names it).
function relocate(old, repo, cwd, opts) {
  const found = findCheckouts(repo, opts.roots ? { roots: opts.roots } : { cwd });
  if (found.status === 'found') {
    const root = resolveRoot(found.path, found.path, cwd);
    return { ...root, relocatedFrom: old };
  }
  if (found.status === 'ambiguous') {
    const cut = found.truncated ? ' (the search was cut short)' : '';
    return {
      status: 'choose',
      path: old,
      candidates: found.candidates,
      reason: `the path does not exist and ${found.candidates.length === 1 ? 'a checkout' : 'several checkouts'} of ${repo} may match${cut}`,
    };
  }
  return { status: 'invalid', path: old, reason: `the path does not exist and no checkout of ${repo} was found` };
}

function check(token, cwd, opts = {}) {
  const d = decodeIn(token);
  if (d === null) return { status: 'invalid', path: '', reason: 'the token does not decode to a path' };
  const p = d.path;
  if (!path.isAbsolute(p)) return { status: 'invalid', path: p, reason: 'the path is not absolute' };
  const canon = real(p);
  if (canon === null) {
    if (d.repo === null) return { status: 'invalid', path: p, reason: 'the path does not exist' };
    return relocate(p, d.repo, cwd, opts);
  }
  return resolveRoot(p, canon, cwd);
}

function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const token = get('--in');
  const cwd = get('--cwd');
  const roots = get('--roots');
  if (token === null || cwd === null) {
    process.stderr.write('usage: trailhead-checkout-in.js --in <token> --cwd <dir> [--roots <a:b>]\n');
    return 2;
  }
  const opts = roots === null ? {} : { roots: roots.split(':').filter((r) => r !== '') };
  process.stdout.write(JSON.stringify(check(token, cwd, opts)) + '\n');
  return 0;
}

module.exports = { encodeIn, decodeIn, check, cdCommand };

if (require.main === module) process.exit(main(process.argv.slice(2)));
