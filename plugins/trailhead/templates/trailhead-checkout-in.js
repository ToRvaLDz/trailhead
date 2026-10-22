#!/usr/bin/env node
'use strict';
// trailhead checkout-in (self-contained, ships in templates/ so it reaches every
// install channel). The panel cannot move the session's directory, so it hands the
// pinned checkout to `work` / `resume` as a trailing `--in=<token>` word and the
// verb moves there first. This helper decodes the token, validates it and says
// whether the session is already there. It fails closed: it never searches for
// another checkout. #312.
//
// The token is base64url(path) (alphabet [A-Za-z0-9_-], no padding), so a path
// with spaces, quotes or a leading `-` travels as one shell-safe word.
//
// CLI:
//   node trailhead-checkout-in.js --in <b64url> --cwd <dir>
//
// Prints exactly one JSON line on stdout:
//   {"status":"here"|"move"|"invalid","path":"...","reason":"...","cd":"..."}
// `cd` is present on `move` only: a ready-to-run, single-quote-escaped command.
// Exit 0 for the three statuses, 2 on a usage error (stderr).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PREFIX = '--in=';

function encodeIn(p) {
  return PREFIX + Buffer.from(String(p), 'utf8').toString('base64url');
}

function decodeIn(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const p = Buffer.from(token, 'base64url').toString('utf8');
  // Round-trip guard: a token that does not re-encode to itself is not ours.
  return p !== '' && Buffer.from(p, 'utf8').toString('base64url') === token ? p : null;
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

function check(token, cwd) {
  const p = decodeIn(token);
  if (p === null) return { status: 'invalid', path: '', reason: 'the token does not decode to a path' };
  if (!path.isAbsolute(p)) return { status: 'invalid', path: p, reason: 'the path is not absolute' };
  const canon = real(p);
  if (canon === null) return { status: 'invalid', path: p, reason: 'the path does not exist' };
  // The path must be a checkout root itself, never a folder inside one.
  if (toplevelOf(p) !== canon) return { status: 'invalid', path: p, reason: 'the path is not the root of a git checkout' };
  const here = real(cwd) !== null ? toplevelOf(cwd) : null;
  if (here === canon) return { status: 'here', path: p };
  return { status: 'move', path: p, cd: cdCommand(p) };
}

function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const token = get('--in');
  const cwd = get('--cwd');
  if (token === null || cwd === null) {
    process.stderr.write('usage: trailhead-checkout-in.js --in <b64url> --cwd <dir>\n');
    return 2;
  }
  process.stdout.write(JSON.stringify(check(token, cwd)) + '\n');
  return 0;
}

module.exports = { encodeIn, decodeIn, check, cdCommand };

if (require.main === module) process.exit(main(process.argv.slice(2)));
