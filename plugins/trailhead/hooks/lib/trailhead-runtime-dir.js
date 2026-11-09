#!/usr/bin/env node
'use strict';
// The project's .trailhead/ runtime dir: one place for the policy every helper
// follows before it writes a file there.
//
// - .trailhead/.gitignore is trailhead's own: seeded on the first write, it
//   ignores everything in the dir (itself included) except config.json, the
//   project config meant to be committed. Lines a user adds are kept; the
//   managed lines are put back on top only when the `*` line is missing.
// - A .trailhead dir, or a runtime file, that is a symlink resolving outside
//   the project is refused: nothing is written through it.
//
// CLI (for the markers the engine writes itself, e.g. session-ticket):
//   node trailhead-runtime-dir.js ensure [--repo <dir>]
// Prints one JSON line {"status","dir"?,"reason"?}:
//   ok (dir ready) | refused (unsafe symlink, nothing written) | skipped (I/O error)
// Exit 0 on every outcome, 2 on a usage error.
//
// hooks/lib/trailhead-runtime-dir.js is a byte-identical copy for the hooks
// (they install without the templates); a test keeps the two in sync.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNTIME_DIR = '.trailhead';
const IGNORE_FILE = '.gitignore';
const MANAGED_LINES = Object.freeze([
  '# Written by trailhead: everything here is per-session state kept out of git,',
  '# except config.json (the project config). Lines you add below are kept.',
  '*',
  '!config.json',
]);

class RuntimeDirRefused extends Error {}

// True when `real` is `rootReal` or sits inside it.
const isInside = (real, rootReal) => real === rootReal || real.startsWith(rootReal + path.sep);

const lstatOrNull = (p, fsMod) => {
  try { return fsMod.lstatSync(p); } catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
};

// A symlink at `p` must resolve inside the project; a dangling one is refused too.
function assertLinkInside(p, root, fsMod) {
  const st = lstatOrNull(p, fsMod);
  if (!st || !st.isSymbolicLink()) return;
  let real;
  try { real = fsMod.realpathSync(p); } catch { real = null; }
  if (real === null || !isInside(real, fsMod.realpathSync(root))) {
    throw new RuntimeDirRefused(`${p} is a symlink pointing outside the project; trailhead does not write through it`);
  }
}

// Atomic write: a unique temp in the same dir, then rename over the file.
function writeAtomic(dir, file, text, fsMod) {
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fsMod.writeFileSync(tmp, text);
    fsMod.renameSync(tmp, file);
  } catch (err) {
    try { fsMod.unlinkSync(tmp); } catch { /* pulizia best effort */ }
    throw err;
  }
}

// Seeds or repairs .trailhead/.gitignore. Best effort: the caller's own write
// never fails because of it. A symlinked .gitignore is left alone.
function seedIgnore(dir, fsMod) {
  const file = path.join(dir, IGNORE_FILE);
  try {
    const st = lstatOrNull(file, fsMod);
    if (st && !st.isFile()) return;
    const text = st ? fsMod.readFileSync(file, 'utf8') : '';
    if (text.split(/\r?\n/).some((l) => l.trim() === '*')) return;
    writeAtomic(dir, file, MANAGED_LINES.join('\n') + '\n' + text, fsMod);
  } catch { /* il file runtime viene comunque scritto */ }
}

// Ready <root>/.trailhead for a write: refuses an unsafe symlink, creates the
// dir, seeds its .gitignore. Returns the dir. Throws RuntimeDirRefused or an I/O error.
function ensureRuntimeDir(root, fsMod = fs) {
  const dir = path.join(root, RUNTIME_DIR);
  assertLinkInside(dir, root, fsMod);
  fsMod.mkdirSync(dir, { recursive: true });
  seedIgnore(dir, fsMod);
  return dir;
}

// Same as ensureRuntimeDir for a file path under some <root>/.trailhead/, and
// refuses a target that is a symlink leaving the project. A file elsewhere
// only gets its parent dir created (the policy is for .trailhead/ alone).
function prepareRuntimeFile(file, fsMod = fs) {
  const dir = path.dirname(file);
  if (path.basename(dir) !== RUNTIME_DIR) {
    fsMod.mkdirSync(dir, { recursive: true });
    return file;
  }
  const root = path.dirname(dir);
  ensureRuntimeDir(root, fsMod);
  assertLinkInside(file, root, fsMod);
  return file;
}

function main(argv, { cwd, stdout, fs: fsMod } = {}) {
  const out = stdout || process.stdout;
  const args = argv || [];
  const repoAt = args.indexOf('--repo');
  if (args[0] !== 'ensure' || (repoAt !== -1 && !args[repoAt + 1]) || args.length !== (repoAt === -1 ? 1 : 3)) {
    process.stderr.write('usage: trailhead-runtime-dir.js ensure [--repo <dir>]\n');
    return 2;
  }
  const root = path.resolve(cwd || process.cwd(), repoAt === -1 ? '.' : args[repoAt + 1]);
  let result;
  try {
    result = { status: 'ok', dir: ensureRuntimeDir(root, fsMod || fs) };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    result = err instanceof RuntimeDirRefused ? { status: 'refused', reason } : { status: 'skipped', reason };
  }
  out.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { RUNTIME_DIR, MANAGED_LINES, RuntimeDirRefused, ensureRuntimeDir, prepareRuntimeFile, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
