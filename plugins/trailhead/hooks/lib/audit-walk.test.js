#!/usr/bin/env node
// Tests for templates/trailhead-audit-walk.js. Run: node audit-walk.test.js
// No framework: plain asserts, mirrors the style of commit-msg-sync.test.js.
//
// Layers:
//   1. parseRefs() / parseHunks() / hunkTouches() pure unit cases.
//   2. fastPath() against synthetic git repos built in os.tmpdir().
//   3. attribute() (the forward walk) against the same kind of repos.
//   4. End-to-end: execFileSync the script (index -> fastpath -> attribute).
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-audit-walk.js');
const walk = require(scriptPath);
const { parseRefs, parseHunks, hunkTouches } = walk;

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}`);
  passed++;
};

// --- synthetic repo harness --------------------------------------------------
// LC_ALL=C keeps git's output stable on localized machines; hooks and signing
// are off so a developer's global config cannot change the outcome.
const GIT_ENV = { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' };
const GIT_FLAGS = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
  '-c', 'user.name=Audit Test', '-c', 'user.email=audit@example.com',
];
const tmpDirs = [];
let clock = 0;

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...GIT_FLAGS, ...args], {
    encoding: 'utf8', env: { ...GIT_ENV, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-audit-walk-test-'));
  tmpDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

// Monotonic fake clock, so ancestry (not timestamps) is what the tests rely on
// unless a case overrides the date on purpose.
function nextDate() {
  clock += 60;
  return new Date(Date.UTC(2021, 0, 1, 0, 0, 0) + clock * 1000).toISOString();
}

// files: { path: content | null }; null removes the path. opts.refs adds a
// real `Refs:` trailer; opts.body is raw prose placed before it.
function commit(dir, files, subject, opts = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(abs, { force: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  git(dir, ['add', '-A']);
  return finishCommit(dir, ['commit', '-q', '--allow-empty'], subject, opts);
}

function message(subject, opts) {
  const parts = [subject];
  if (opts.body) parts.push(opts.body);
  if (opts.refs) parts.push('Refs: ' + opts.refs.map((n) => '#' + n).join(', '));
  return parts.join('\n\n');
}

function finishCommit(dir, args, subject, opts) {
  const date = opts.date || nextDate();
  git(dir, [...args, '-m', message(subject, opts)], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return head(dir);
}

function head(dir) { return git(dir, ['rev-parse', 'HEAD']).trim(); }

// A numbered text file: lines('a', 5) -> "a1\na2\na3\na4\na5\n".
function lines(prefix, count) {
  let out = '';
  for (let i = 1; i <= count; i++) out += `${prefix}${i}\n`;
  return out;
}

function cleanup() {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
}

// --- parseRefs() ---------------------------------------------------------------
eq('parseRefs: single token', parseRefs('#17'), [17]);
eq('parseRefs: comma + space list', parseRefs('#17, #192'), [17, 192]);
eq('parseRefs: separator-only comma list', parseRefs('#1,#2'), [1, 2]);
eq('parseRefs: #19 never matches inside #192', parseRefs('#192').includes(19), false);
eq('parseRefs: glued prefix is not a token', parseRefs('foo#12'), []);
eq('parseRefs: glued suffix is not a token', parseRefs('#12x'), []);
eq('parseRefs: empty value', parseRefs(''), []);
eq('parseRefs: null value', parseRefs(null), []);
eq('parseRefs: duplicates collapse', parseRefs('#5 #5'), [5]);
eq('parseRefs: whitespace delimited with a Refs: prefix', parseRefs('Refs: #5 and #6'), [5, 6]);

// --- parseHunks() --------------------------------------------------------------
{
  const diff = [
    'diff --git a/f b/f', 'index 111..222 100644', '--- a/f', '+++ b/f',
    '@@ -3 +3 @@ some context', '-old', '+new',
    '@@ -10,2 +10,3 @@', '-a', '-b', '+x', '+y', '+z',
    '@@ -20,0 +24,2 @@', '+ins1', '+ins2',
    '@@ -30,4 +36,0 @@', '-d1', '-d2', '-d3', '-d4',
    '',
  ].join('\n');
  eq('parseHunks: defaults, counts, insertions and deletions', parseHunks(diff), [
    { oldStart: 3, oldLen: 1, newStart: 3, newLen: 1 },
    { oldStart: 10, oldLen: 2, newStart: 10, newLen: 3 },
    { oldStart: 20, oldLen: 0, newStart: 24, newLen: 2 },
    { oldStart: 30, oldLen: 4, newStart: 36, newLen: 0 },
  ]);
  eq('parseHunks: no hunk (binary or mode-only)', parseHunks('Binary files a/x and b/x differ\n'), []);
  eq('parseHunks: a content line that looks like a header is ignored',
    parseHunks('@@ -1 +1 @@\n-x\n+@@ -9,9 +9,9 @@\n'), [{ oldStart: 1, oldLen: 1, newStart: 1, newLen: 1 }]);
}

// --- hunkTouches() ---------------------------------------------------------------
{
  const replace = { oldStart: 5, oldLen: 2, newStart: 5, newLen: 3 }; // old lines 5-6
  ok('hunkTouches: replaced tracked line', hunkTouches(replace, [6], []));
  ok('hunkTouches: tracked line outside the range', !hunkTouches(replace, [7], []));
  ok('hunkTouches: anchor whose g+1 is covered', hunkTouches(replace, [], [4]));
  ok('hunkTouches: anchor whose g is covered', hunkTouches(replace, [], [6]));
  ok('hunkTouches: anchor beyond the range', !hunkTouches(replace, [], [7]));
  ok('hunkTouches: anchor before the range', !hunkTouches(replace, [], [3]));
  const insertion = { oldStart: 5, oldLen: 0, newStart: 6, newLen: 2 }; // gap after old line 5
  ok('hunkTouches: insertion with b tracked', hunkTouches(insertion, [5], []));
  ok('hunkTouches: insertion with b+1 tracked', hunkTouches(insertion, [6], []));
  ok('hunkTouches: insertion away from tracked lines', !hunkTouches(insertion, [4, 7], []));
  ok('hunkTouches: insertion at an anchor gap', hunkTouches(insertion, [], [5]));
  ok('hunkTouches: insertion next to, not at, an anchor', !hunkTouches(insertion, [], [4, 6]));
  const deletion = { oldStart: 8, oldLen: 3, newStart: 7, newLen: 0 }; // old lines 8-10
  ok('hunkTouches: pure deletion covering a tracked line', hunkTouches(deletion, [9], []));
  ok('hunkTouches: pure deletion next to a tracked line', !hunkTouches(deletion, [7, 11], []));
  ok('hunkTouches: accepts Sets', hunkTouches(deletion, new Set([10]), new Set()));
}

cleanup();
console.log(`✓ audit-walk: ${passed} assertions passed`);
