#!/usr/bin/env node
'use strict';
// Drift check for the compact capture reference, skills/_shared/capture-core.md,
// against the full shared core it restates. #330.
//
// CLI:
//   node scripts/capture-core-drift.js --check    write nothing; exit 1 naming every
//                                                 marker whose source line changed or
//                                                 whose anchor vanished
//   node scripts/capture-core-drift.js --update   rewrite the hashes; run it only after
//                                                 a human re-read the compact rule
//
// Every rule the compact file restates carries a marker line of its own:
//   <!-- core: <file> | <anchor> | <sha8> -->
// <file> is a file of the shared core dir, <anchor> a short verbatim phrase of the
// source line (the first line of <file> containing it), <sha8> the first 8 hex of the
// sha256 of that whole line. The core's rules are one-line bullets or paragraphs, so
// any edit of a mirrored rule changes the hash and fails the check until the compact
// rule is re-read and re-stamped.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHARED_DIR = path.resolve(__dirname, '..', 'plugins', 'trailhead', 'skills', '_shared');
const COMPACT_PATH = path.join(SHARED_DIR, 'capture-core.md');

const MARKER_RE = /^<!-- core: (\S+) \| (.+?) \| ([0-9a-f]{8}) -->[ \t]*$/;

// First 8 hex of the sha256 of a source line (trailing whitespace and CR ignored).
const hashLine = (line) => crypto.createHash('sha256').update(String(line).replace(/\s+$/, '')).digest('hex').slice(0, 8);

// Compact text -> [{ index, file, anchor, sha }], one per marker line.
function parseMarkers(text) {
  const out = [];
  String(text).split('\n').forEach((raw, index) => {
    const m = MARKER_RE.exec(raw);
    if (m) out.push({ index, file: m[1], anchor: m[2], sha: m[3] });
  });
  return out;
}

// The first line of `sourceText` containing `anchor`, or null.
function findSourceLine(sourceText, anchor) {
  const hit = String(sourceText).split('\n').find((l) => l.includes(anchor));
  return hit === undefined ? null : hit;
}

// Resolves every marker against the source files: [{ marker, status, actual }] with
// status ok | changed | no-file | no-anchor. `read(file)` returns the text or null.
function evaluate(text, read) {
  return parseMarkers(text).map((marker) => {
    const src = read(marker.file);
    if (src === null) return { marker, status: 'no-file' };
    const line = findSourceLine(src, marker.anchor);
    if (line === null) return { marker, status: 'no-anchor' };
    const actual = hashLine(line);
    return { marker, status: actual === marker.sha ? 'ok' : 'changed', actual };
  });
}

const reader = (sharedDir) => (file) => {
  if (file.includes('/') || file.includes('\\')) return null;
  try { return fs.readFileSync(path.join(sharedDir, file), 'utf8'); } catch { return null; }
};

const describe = (r) => {
  const where = `${r.marker.file} | ${r.marker.anchor}`;
  if (r.status === 'no-file') return `${where}: source file not found`;
  if (r.status === 'no-anchor') return `${where}: anchor not found in the source`;
  return `${where}: source line changed (stamped ${r.marker.sha}, now ${r.actual})`;
};

// Problems of the compact file against the shared dir; [] when in sync.
function check({ compactPath = COMPACT_PATH, sharedDir = SHARED_DIR } = {}) {
  const text = fs.readFileSync(compactPath, 'utf8');
  const results = evaluate(text, reader(sharedDir));
  if (results.length === 0) return ['no drift markers found in the compact file'];
  return results.filter((r) => r.status !== 'ok').map(describe);
}

// Text with every marker hash recomputed; throws when a file or anchor is gone.
function stamp(text, read) {
  const results = evaluate(text, read);
  const bad = results.filter((r) => r.status === 'no-file' || r.status === 'no-anchor');
  if (bad.length) throw new Error(bad.map(describe).join('; '));
  const lines = String(text).split('\n');
  for (const r of results) {
    lines[r.marker.index] = `<!-- core: ${r.marker.file} | ${r.marker.anchor} | ${r.actual} -->`;
  }
  return lines.join('\n');
}

function main(argv, out = process.stdout, err = process.stderr) {
  const mode = argv.length === 1 ? argv[0] : null;
  if (mode !== '--check' && mode !== '--update') {
    err.write('usage: capture-core-drift.js (--check | --update)\n');
    return 2;
  }
  try {
    if (mode === '--check') {
      const problems = check();
      if (problems.length === 0) return 0;
      err.write(`capture-core.md drifted from the full shared core; re-read each rule, then run --update:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
      return 1;
    }
    const text = fs.readFileSync(COMPACT_PATH, 'utf8');
    const next = stamp(text, reader(SHARED_DIR));
    if (next !== text) fs.writeFileSync(COMPACT_PATH, next);
    out.write(next !== text ? 'capture-core.md hashes updated\n' : 'capture-core.md hashes already current\n');
    return 0;
  } catch (e) {
    err.write(`capture-core-drift: ${e.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { hashLine, parseMarkers, findSourceLine, evaluate, check, stamp, main, SHARED_DIR, COMPACT_PATH };
