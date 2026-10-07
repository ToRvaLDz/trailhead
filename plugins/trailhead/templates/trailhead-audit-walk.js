#!/usr/bin/env node
'use strict';
// trailhead audit walk (self-contained, ships in templates/ so it reaches every
// install channel, like trailhead-commit-msg-sync.js). Runs the deterministic
// parts of `/trailhead:audit`: the fast path (references/auditing.md step 4)
// and the attribution walk (step 6). The prose in auditing.md stays the spec;
// this script implements it. #193.
//
// CLI (JSON on stdout, exit 0; usage or fatal errors exit 2 with {"error":...}):
//   index     --repo <dir>
//   fastpath  --repo <dir> [--index <file>] <n> [<n>...]
//   attribute --repo <dir> [--index <file>] --ticket <n> --claim <spec> [--claim <spec>...]
// A claim spec is a comma list of `<path>:<s>-<e>` (HEAD line range) or
// `<path>:@<g>` (deletion gap after HEAD line g). `index` prints the trailer
// index; save it and pass it back with --index so a whole audit scans once.
//
// Git is only ever run through execFileSync('git', ['-C', repo, ...]), never a
// shell, with LC_ALL=C so output parsing is stable on localized machines.

// Tokens `#<digits>` delimited by start/end, comma or whitespace, so `#19`
// never matches inside `#192`. Input is the value of a parsed `Refs:` trailer.
function parseRefs(value) {
  const found = [];
  const re = /(?:^|[,\s])#(\d+)(?=$|[,\s])/g;
  const text = String(value == null ? '' : value);
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

// `@@ -a,k +b,l @@` headers of a unified diff, in order. A missing count is 1.
// Only lines that START with `@@ ` are headers: diff content lines always begin
// with ` `, `+` or `-`, so a content line can never be mistaken for one.
function parseHunks(diffText) {
  const hunks = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of String(diffText).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldLen: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLen: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

// The shared touching rule (auditing.md step 4). `tracked` is a set of old-side
// line numbers, `anchors` a set of deletion gaps (gap g = after old line g).
// A hunk touches when its old range overlaps a tracked line or covers line g or
// g+1 of an anchor; a pure insertion `-b,0` touches when b or b+1 is tracked or
// an anchor sits at gap b.
function hunkTouches(hunk, tracked, anchors) {
  const lines = tracked instanceof Set ? tracked : new Set(tracked || []);
  const gaps = anchors instanceof Set ? anchors : new Set(anchors || []);
  if (hunk.oldLen === 0) {
    const b = hunk.oldStart;
    return lines.has(b) || lines.has(b + 1) || gaps.has(b);
  }
  const start = hunk.oldStart;
  const end = hunk.oldStart + hunk.oldLen - 1;
  for (const line of lines) if (line >= start && line <= end) return true;
  for (const g of gaps) if ((g >= start && g <= end) || (g + 1 >= start && g + 1 <= end)) return true;
  return false;
}

module.exports = { parseRefs, parseHunks, hunkTouches };
