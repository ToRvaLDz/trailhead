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

// --- fast path ---------------------------------------------------------------
const { buildTrailerIndex, fastPath } = walk;

// 1-based splice on a text file: splice(text, 3, 2, 'x') replaces lines 3-4.
function splice(text, start, del, ...ins) {
  const arr = text.replace(/\n$/, '').split('\n');
  arr.splice(start - 1, del, ...ins);
  return arr.join('\n') + '\n';
}

// A repo with f.txt (10 lines) and other.txt; returns { dir, f, base }.
function baseRepo() {
  const dir = mkrepo();
  const f = lines('a', 10);
  const base = commit(dir, { 'f.txt': f, 'other.txt': lines('o', 3) }, 'chore: base');
  return { dir, f, base };
}

function fp(dir, n) { return fastPath(dir, n, buildTrailerIndex(dir)); }

// Merge `branch` into the current branch; `resolved` (files) settles conflicts.
function mergeBranch(dir, branch, resolved, subject, opts = {}) {
  try { git(dir, ['merge', '-q', '--no-ff', '--no-commit', branch]); } catch { /* conflict: resolved below */ }
  for (const [rel, content] of Object.entries(resolved || {})) fs.writeFileSync(path.join(dir, rel), content);
  git(dir, ['add', '-A']);
  return finishCommit(dir, ['commit', '-q', '--allow-empty'], subject, opts);
}

// untouched ticket code is unchanged
{
  const { dir, f } = baseRepo();
  const c2 = commit(dir, { 'f.txt': splice(f, 3, 2, 'T3', 'T4') }, 'feat: ticket', { refs: [1] });
  commit(dir, { 'other.txt': lines('p', 3) }, 'chore: elsewhere');
  const r = fp(dir, 1);
  eq('fastPath untouched: class and reason', [r.class, r.reason], ['unchanged', null]);
  eq('fastPath untouched: last, commits, files', [r.last, r.commits, r.files], [c2, [c2], ['f.txt']]);
  eq('fastPath untouched: evolvedEligible', r.evolvedEligible, true);
  eq('fastPath untouched: ticket field', r.ticket, 1);
}

// an edit of a ticket line is changed
{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  commit(dir, { 'f.txt': splice(t, 3, 1, 'X3') }, 'fix: later edit');
  const r = fp(dir, 1);
  eq('fastPath edited line: changed/touching-hunk', [r.class, r.reason], ['changed', 'touching-hunk']);
  eq('fastPath edited line: still evolved-eligible', r.evolvedEligible, true);
}

// an edit elsewhere in the same file is unchanged
{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  commit(dir, { 'f.txt': splice(t, 9, 1, 'X9') }, 'fix: far edit');
  eq('fastPath edit elsewhere: unchanged', fp(dir, 1).class, 'unchanged');
}

// pure deletion: the anchor decides
{
  const touched = baseRepo();
  const t = splice(touched.f, 5, 2); // ticket deletes a5-a6 -> gap after line 4
  commit(touched.dir, { 'f.txt': t }, 'feat: delete', { refs: [1] });
  commit(touched.dir, { 'f.txt': splice(t, 4, 1, 'X4') }, 'fix: edit at the anchor');
  const r = fp(touched.dir, 1);
  eq('fastPath deletion anchor touched: changed/touching-hunk', [r.class, r.reason], ['changed', 'touching-hunk']);

  const gapEdge = baseRepo();
  const t2 = splice(gapEdge.f, 5, 2);
  commit(gapEdge.dir, { 'f.txt': t2 }, 'feat: delete', { refs: [1] });
  commit(gapEdge.dir, { 'f.txt': splice(t2, 5, 1, 'X5') }, 'fix: edit after the anchor');
  eq('fastPath deletion anchor edge (g+1): changed', fp(gapEdge.dir, 1).reason, 'touching-hunk');

  const untouched = baseRepo();
  const t3 = splice(untouched.f, 5, 2);
  commit(untouched.dir, { 'f.txt': t3 }, 'feat: delete', { refs: [1] });
  commit(untouched.dir, { 'f.txt': splice(t3, 8, 1, 'X8') }, 'fix: edit away from the anchor');
  eq('fastPath deletion anchor untouched: unchanged', fp(untouched.dir, 1).class, 'unchanged');
}

// insertion inside, at the edge of, and away from the ticket span
{
  const mk = (insertAfter) => {
    const { dir, f } = baseRepo();
    const t = splice(f, 3, 4, 'T3', 'T4', 'T5', 'T6'); // ticket owns lines 3-6
    commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
    commit(dir, { 'f.txt': splice(t, insertAfter + 1, 0, 'NEW') }, 'fix: insert');
    return fp(dir, 1);
  };
  eq('fastPath insertion inside the span: changed', mk(4).reason, 'touching-hunk');
  eq('fastPath insertion at the edge of the span: changed', mk(6).reason, 'touching-hunk');
  eq('fastPath insertion far from the span: unchanged', mk(9).class, 'unchanged');
}

// rename or delete since is deleted-or-renamed
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  git(dir, ['mv', 'f.txt', 'g.txt']);
  finishCommit(dir, ['commit', '-q'], 'refactor: rename', {});
  const r = fp(dir, 1);
  eq('fastPath rename since: deleted-or-renamed', [r.class, r.reason], ['changed', 'deleted-or-renamed']);
}
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  commit(dir, { 'f.txt': null }, 'chore: drop file');
  eq('fastPath delete since: deleted-or-renamed', fp(dir, 1).reason, 'deleted-or-renamed');
}

// a file the ticket deleted counts only if it exists again at HEAD
{
  const { dir } = baseRepo();
  commit(dir, { 'f.txt': null }, 'chore: ticket deletes', { refs: [1] });
  eq('fastPath ticket-deleted file stays gone: unchanged', fp(dir, 1).class, 'unchanged');
  commit(dir, { 'f.txt': 'again\n' }, 'feat: recreated');
  const r = fp(dir, 1);
  eq('fastPath ticket-deleted file recreated: changed/recreated', [r.class, r.reason], ['changed', 'recreated']);
}

// a file that differs without a textual hunk is non-textual (mode-only, binary)
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  fs.chmodSync(path.join(dir, 'f.txt'), 0o755);
  commit(dir, {}, 'chore: chmod');
  const r = fp(dir, 1);
  eq('fastPath mode-only change: non-textual', [r.class, r.reason], ['changed', 'non-textual']);
}
{
  const dir = mkrepo();
  commit(dir, { 'img.bin': Buffer.from([0, 1, 2, 3, 0, 4]).toString('latin1') }, 'chore: base');
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 9, 9, 9, 0, 4]));
  commit(dir, {}, 'feat: ticket binary', { refs: [1] });
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 7, 7, 7, 0, 4]));
  commit(dir, {}, 'fix: binary changes');
  eq('fastPath binary change: non-textual', fp(dir, 1).reason, 'non-textual');
}

// an empty file at <last> that differs is changed
{
  const { dir } = baseRepo();
  commit(dir, { 'e.txt': '' }, 'feat: empty file', { refs: [1] });
  eq('fastPath empty file unchanged', fp(dir, 1).class, 'unchanged');
  commit(dir, { 'e.txt': 'now has content\n' }, 'feat: fills it');
  eq('fastPath empty file that differs: touching-hunk', fp(dir, 1).reason, 'touching-hunk');
}

// no Refs commits -> no-refs
{
  const { dir } = baseRepo();
  const r = fp(dir, 99);
  eq('fastPath no Refs: changed/no-refs', [r.class, r.reason], ['changed', 'no-refs']);
  eq('fastPath no Refs: ineligible, empty commits', [r.evolvedEligible, r.commits, r.last], [false, [], null]);
}

// #19 never matches #192, prose Refs lines are ignored
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket 192', { refs: [17, 192], body: 'Refs: #19 is only prose here' });
  eq('fastPath #19 does not match #192: no-refs', fp(dir, 19).reason, 'no-refs');
  eq('fastPath #192 in a multi-ref trailer', fp(dir, 192).class, 'unchanged');
  eq('fastPath #17 in the same trailer', fp(dir, 17).class, 'unchanged');
}

// non-linear: ticket commits on incomparable branches
{
  const { dir, f } = baseRepo();
  git(dir, ['checkout', '-q', '-b', 'side']);
  commit(dir, { 'f.txt': splice(f, 2, 1, 'S2') }, 'feat: side part', { refs: [1] });
  git(dir, ['checkout', '-q', 'main']);
  commit(dir, { 'f.txt': splice(f, 8, 1, 'M8') }, 'feat: main part', { refs: [1] });
  mergeBranch(dir, 'side', {}, 'merge: side');
  const r = fp(dir, 1);
  eq('fastPath non-linear: changed/non-linear', [r.class, r.reason, r.evolvedEligible], ['changed', 'non-linear', false]);
}

// ticket commits ordered by ancestry, never by timestamp
{
  const { dir, f } = baseRepo();
  const t1 = splice(f, 2, 1, 'T2');
  const c2 = commit(dir, { 'f.txt': t1 }, 'feat: first', { refs: [1], date: '2030-01-01T00:00:00Z' });
  const c3 = commit(dir, { 'f.txt': splice(t1, 8, 1, 'T8') }, 'feat: second', { refs: [1], date: '2001-01-01T00:00:00Z' });
  const r = fp(dir, 1);
  eq('fastPath out-of-order dates: ancestry picks last', [r.last, r.commits, r.class], [c3, [c2, c3], 'unchanged']);
}

// guard: a non-ticket commit on the chain touching a ticket file
{
  const { dir, f } = baseRepo();
  const t = splice(f, 2, 1, 'T2');
  commit(dir, { 'f.txt': t }, 'feat: first', { refs: [1] });
  const mid = splice(t, 9, 1, 'X9');
  commit(dir, { 'f.txt': mid }, 'fix: foreign edit in the same file');
  commit(dir, { 'f.txt': splice(mid, 5, 1, 'T5') }, 'feat: second', { refs: [1] });
  const r = fp(dir, 1);
  eq('fastPath guard on the chain: changed/guard', [r.class, r.reason, r.evolvedEligible], ['changed', 'guard', true]);
}
// a side branch that never joins the chain is not a guard hit
{
  const { dir, f } = baseRepo();
  const t = splice(f, 2, 1, 'T2');
  commit(dir, { 'f.txt': t }, 'feat: first', { refs: [1] });
  git(dir, ['checkout', '-q', '-b', 'side']);
  commit(dir, { 'f.txt': splice(t, 9, 1, 'S9') }, 'fix: unmerged side edit');
  git(dir, ['checkout', '-q', 'main']);
  commit(dir, { 'f.txt': splice(t, 5, 1, 'T5') }, 'feat: second', { refs: [1] });
  eq('fastPath unmerged side branch: not a guard hit', fp(dir, 1).class, 'unchanged');
}

// a later ticket commit around an earlier deletion keeps the anchor
{
  const { dir, f } = baseRepo();
  const t = splice(f, 5, 2); // a1-a4, a7-a10: anchor after line 4
  commit(dir, { 'f.txt': t }, 'feat: delete', { refs: [1] });
  const t2 = splice(t, 5, 1); // ticket deletes a7 too: pure deletion at the anchor edge
  commit(dir, { 'f.txt': t2 }, 'feat: delete more', { refs: [1] });
  eq('fastPath anchor survives a later ticket deletion: unchanged', fp(dir, 1).class, 'unchanged');
  commit(dir, { 'f.txt': splice(t2, 4, 1, 'X4') }, 'fix: edit at the carried anchor');
  eq('fastPath carried anchor still detects an edit', fp(dir, 1).reason, 'touching-hunk');
}
{
  const { dir, f } = baseRepo();
  const t = splice(f, 5, 2);
  commit(dir, { 'f.txt': t }, 'feat: delete', { refs: [1] });
  const t2 = splice(t, 5, 1);
  commit(dir, { 'f.txt': t2 }, 'feat: delete more', { refs: [1] });
  commit(dir, { 'f.txt': splice(t2, 7, 1, 'X7') }, 'fix: edit far away');
  eq('fastPath carried anchor, edit far away: unchanged', fp(dir, 1).class, 'unchanged');
}

// a ticket commit that is itself a merge: files, hunks and blame use the chosen parent
{
  const { dir, f } = baseRepo();
  git(dir, ['checkout', '-q', '-b', 'side']);
  commit(dir, { 'f.txt': splice(f, 5, 1, 'side5'), 's.txt': 'side file\n' }, 'feat: side work');
  git(dir, ['checkout', '-q', 'main']);
  const m1 = splice(f, 5, 1, 'main5');
  commit(dir, { 'f.txt': m1 }, 'feat: main work');
  const merged = splice(f, 5, 1, 'merged5');
  const mc = mergeBranch(dir, 'side', { 'f.txt': merged }, 'merge: side, resolved', { refs: [1] });
  let r = fp(dir, 1);
  eq('fastPath ticket merge: last is the merge, files vs first parent',
    [r.last, r.files, r.class], [mc, ['f.txt', 's.txt'], 'unchanged']);
  commit(dir, { 'f.txt': splice(merged, 1, 1, 'X1') }, 'fix: far edit');
  eq('fastPath ticket merge: far edit unchanged', fp(dir, 1).class, 'unchanged');
  commit(dir, { 'f.txt': splice(splice(merged, 1, 1, 'X1'), 5, 1, 'X5') }, 'fix: edit the resolved line');
  eq('fastPath ticket merge: edit of the resolved line', fp(dir, 1).reason, 'touching-hunk');
}

// a stale or malformed index is rejected, never silently used
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  const index = buildTrailerIndex(dir);
  commit(dir, { 'other.txt': 'moved on\n' }, 'chore: moves HEAD');
  assert.throws(() => fastPath(dir, 1, index), /stale/); passed++;
  assert.throws(() => fastPath(dir, 1, { head: head(dir) }), /malformed/); passed++;
  const fresh = buildTrailerIndex(dir);
  eq('buildTrailerIndex: head, shallow, byTicket', [fresh.head, fresh.shallow, Object.keys(fresh.byTicket)], [head(dir), false, ['1']]);
  eq('buildTrailerIndex: refsBySha lists only trailer commits', Object.values(fresh.refsBySha), [[1]]);
}

// dirty ticket files are reported without any effect on the class
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'uncommitted\n');
  const r = fp(dir, 1);
  eq('fastPath dirty tree: class unaffected, file reported', [r.class, r.dirtyFiles], ['unchanged', ['f.txt']]);
}

// shallow clones send every ticket to the agent and are ineligible for evolved
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  const clone = path.join(os.tmpdir(), 'trailhead-audit-walk-shallow-' + process.pid);
  tmpDirs.push(clone);
  execFileSync('git', ['clone', '-q', '--depth', '1', '--no-local', 'file://' + dir, clone], { env: GIT_ENV, stdio: 'pipe' });
  const index = buildTrailerIndex(clone);
  const r = fastPath(clone, 1, index);
  eq('fastPath shallow: changed/shallow, ineligible', [index.shallow, r.class, r.reason, r.evolvedEligible], [true, 'changed', 'shallow', false]);
}

// --- attribution walk ----------------------------------------------------------
const { attribute } = walk;

function att(dir, n, specs) { return attribute(dir, n, specs, buildTrailerIndex(dir)); }
function shas(claim) { return claim.producers.map((p) => p.sha).sort(); }

// edit by a #m commit -> attributed, evolvedBy m
{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  const c3 = commit(dir, { 'f.txt': splice(t, 3, 1, 'M3') }, 'feat: later ticket', { refs: [2] });
  const r = att(dir, 1, ['f.txt:3-4', 'f.txt:9-10']);
  eq('attribute edit by #2: eligible', [r.ticket, r.eligible, r.reason], [1, true, null]);
  eq('attribute edit by #2: claim 3-4', r.claims[0], {
    spec: 'f.txt:3-4', attributed: true, evolvedBy: [2], producers: [{ sha: c3, refs: [2] }],
  });
  eq('attribute untouched range: not attributed, no producers', r.claims[1],
    { spec: 'f.txt:9-10', attributed: false, evolvedBy: [], producers: [] });
  const multi = att(dir, 1, ['f.txt:9-9,f.txt:3-3']);
  eq('attribute comma list: union of its ranges', [multi.claims[0].attributed, shas(multi.claims[0])], [true, [c3]]);
  assert.throws(() => att(dir, 1, ['f.txt:nonsense']), /invalid claim/); passed++;
}

// an edit with no trailer is not attributed
{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  const c3 = commit(dir, { 'f.txt': splice(t, 3, 1, 'M3') }, 'fix: untracked edit');
  const c = att(dir, 1, ['f.txt:3-3']).claims[0];
  eq('attribute no trailer: not attributed', [c.attributed, c.evolvedBy, c.producers], [false, [], [{ sha: c3, refs: [] }]]);
}

// an unrelated edit elsewhere in the file never attributes the claim
{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  commit(dir, { 'f.txt': splice(t, 8, 1, 'M8') }, 'feat: elsewhere', { refs: [2] });
  const c = att(dir, 1, ['f.txt:3-4']).claims[0];
  eq('attribute unrelated edit elsewhere: no producers', [c.attributed, c.producers], [false, []]);
}

// a deletion by #m, claimed as a gap
{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  const c3 = commit(dir, { 'f.txt': splice(t, 3, 2) }, 'refactor: remove them', { refs: [2] });
  const c = att(dir, 1, ['f.txt:@2']).claims[0];
  eq('attribute deletion by #2 (@g claim)', [c.attributed, c.evolvedBy, shas(c)], [true, [2], [c3]]);
}

// the ticket's own deletion anchor, later edited around by #m
{
  const { dir, f } = baseRepo();
  const t = splice(f, 5, 2);
  commit(dir, { 'f.txt': t }, 'feat: delete', { refs: [1] });
  const c3 = commit(dir, { 'f.txt': splice(t, 4, 1, 'X4') }, 'fix: edit at the anchor', { refs: [2] });
  const c = att(dir, 1, ['f.txt:@4']).claims[0];
  eq('attribute own anchor edited by #2', [c.attributed, c.evolvedBy, shas(c)], [true, [2], [c3]]);
}

// a file deleted by #m: the claim naming that path is attributed
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  const c3 = commit(dir, { 'f.txt': null }, 'chore: drop file', { refs: [2] });
  const c = att(dir, 1, ['f.txt:1-10']).claims[0];
  eq('attribute file deleted by #2', [c.attributed, c.evolvedBy, shas(c)], [true, [2], [c3]]);
}

// rename, then an edit: the claim is on the new HEAD path
{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  git(dir, ['mv', 'f.txt', 'g.txt']);
  finishCommit(dir, ['commit', '-q'], 'refactor: rename', {});
  const c4 = commit(dir, { 'g.txt': splice(t, 3, 1, 'M3') }, 'feat: edit after rename', { refs: [3] });
  const r = att(dir, 1, ['g.txt:3-3', 'f.txt:3-3']);
  eq('attribute rename then edit: claim on the new path', [r.claims[0].attributed, r.claims[0].evolvedBy, shas(r.claims[0])], [true, [3], [c4]]);
  eq('attribute rename then edit: the old path no longer matches', [r.claims[1].attributed, r.claims[1].producers], [false, []]);
}

// coordinates shift above the claim; matching happens in HEAD coordinates only
{
  const { dir, f } = baseRepo();
  const t = splice(f, 6, 2, 'T6', 'T7'); // ticket owns 6-7
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  const t3 = splice(t, 2, 0, 'I1', 'I2'); // non-touching insertion above: ticket now 8-9
  commit(dir, { 'f.txt': t3 }, 'feat: insert above', { refs: [2] });
  const t4 = splice(t3, 1, 1); // non-touching deletion above: ticket now 7-8
  commit(dir, { 'f.txt': t4 }, 'refactor: drop first line', { refs: [3] });
  const c5 = commit(dir, { 'f.txt': splice(t4, 7, 1, 'X') }, 'fix: edit the shifted line', { refs: [2] });
  const r = att(dir, 1, ['f.txt:7-7', 'f.txt:6-6', 'f.txt:8-8']);
  eq('attribute shift: HEAD line 7 is the ticket line', [r.claims[0].attributed, r.claims[0].evolvedBy, shas(r.claims[0])], [true, [2], [c5]]);
  eq('attribute shift: HEAD line 6 is not the ticket line', r.claims[1].producers, []);
  eq('attribute shift: untouched ticket line has no producers', r.claims[2].producers, []);
}

// merges: a simple side history is expanded to the exact side commits
function mergeScenario(sideSetup) {
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  git(dir, ['checkout', '-q', '-b', 'side']);
  const side = sideSetup(dir, t);
  git(dir, ['checkout', '-q', 'main']);
  return { dir, t, f, side };
}
{
  let s1; let s2;
  const sc = mergeScenario((dir, t) => {
    s1 = commit(dir, { 'f.txt': splice(t, 3, 1, 'S1_3') }, 'feat: side one', { refs: [2] });
    s2 = commit(dir, { 'f.txt': splice(t, 3, 1, 'S2_3') }, 'feat: side two', { refs: [3] });
  });
  commit(sc.dir, { 'other.txt': 'main moves\n' }, 'chore: main moves');
  const m = mergeBranch(sc.dir, 'side', {}, 'merge: side');
  const c = att(sc.dir, 1, ['f.txt:3-3']).claims[0];
  eq('attribute simple merge: exact producers {s1, s2}', [shas(c), c.attributed, c.evolvedBy], [[s1, s2].sort(), true, [2, 3]]);
  ok('attribute simple merge: the merge itself is not a producer', !shas(c).includes(m));
}

// a conflict-resolved merge is a producer next to the side commit
{
  let s1;
  const sc = mergeScenario((dir, t) => {
    s1 = commit(dir, { 'f.txt': splice(t, 4, 1, 'S4') }, 'feat: side edit of line 4', { refs: [2] });
  });
  commit(sc.dir, { 'f.txt': splice(sc.t, 3, 1, 'M3') }, 'feat: main edit of line 3', { refs: [4] });
  const resolved = splice(splice(sc.t, 3, 1, 'M3'), 4, 1, 'R4');
  const m = mergeBranch(sc.dir, 'side', { 'f.txt': resolved }, 'merge: resolved', { refs: [5] });
  const c = att(sc.dir, 1, ['f.txt:4-4']).claims[0];
  eq('attribute conflict-resolved merge: {merge, side commit}', [shas(c), c.attributed, c.evolvedBy], [[m, s1].sort(), true, [2, 5]]);
}

// a nested merge falls back to the merge commit itself
{
  const sc = mergeScenario((dir, t) => {
    commit(dir, { 'f.txt': splice(t, 4, 1, 'S4') }, 'feat: side edit', { refs: [2] });
    git(dir, ['checkout', '-q', '-b', 'sub']);
    commit(dir, { 'u.txt': 'sub\n' }, 'feat: sub work', { refs: [3] });
    git(dir, ['checkout', '-q', 'side']);
    commit(dir, { 'v.txt': 'side\n' }, 'feat: side work', { refs: [4] });
    mergeBranch(dir, 'sub', {}, 'merge: sub into side');
  });
  commit(sc.dir, { 'other.txt': 'main moves\n' }, 'chore: main moves');
  const m = mergeBranch(sc.dir, 'side', {}, 'merge: side');
  const c = att(sc.dir, 1, ['f.txt:4-4']).claims[0];
  eq('attribute nested merge: falls back to the merge, no trailer', [c.attributed, c.producers], [false, [{ sha: m, refs: [] }]]);
}

// a rename on the side falls back to the merge commit itself
{
  const sc = mergeScenario((dir, t) => {
    commit(dir, { 'f.txt': splice(t, 4, 1, 'S4') }, 'feat: side edit', { refs: [2] });
    git(dir, ['mv', 'f.txt', 'h.txt']);
    finishCommit(dir, ['commit', '-q'], 'refactor: side rename', { refs: [3] });
  });
  commit(sc.dir, { 'other.txt': 'main moves\n' }, 'chore: main moves');
  const m = mergeBranch(sc.dir, 'side', {}, 'merge: side');
  const c = att(sc.dir, 1, ['h.txt:4-4']).claims[0];
  eq('attribute rename on side: falls back to the merge', [c.attributed, c.producers], [false, [{ sha: m, refs: [] }]]);
}

// old-side tracked lines a merge deletes: the merge itself is the producer
{
  const sc = mergeScenario((dir, t) => {
    commit(dir, { 'f.txt': splice(t, 3, 2) }, 'refactor: side deletes the lines', { refs: [2] });
  });
  commit(sc.dir, { 'other.txt': 'main moves\n' }, 'chore: main moves');
  const m = mergeBranch(sc.dir, 'side', {}, 'merge: side');
  const c = att(sc.dir, 1, ['f.txt:@2']).claims[0];
  eq('attribute merge deleting tracked lines: producer is the merge', [c.attributed, c.producers], [false, [{ sha: m, refs: [] }]]);
}

// ineligible tickets are never attributed
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'M3') }, 'feat: someone', { refs: [2] });
  const r = att(dir, 99, ['f.txt:3-3']);
  eq('attribute no-refs: ineligible', [r.eligible, r.reason], [false, 'no-refs']);
  eq('attribute no-refs: claims not attributed', r.claims, [{ spec: 'f.txt:3-3', attributed: false, evolvedBy: [], producers: [] }]);
}
{
  const { dir, f } = baseRepo();
  git(dir, ['checkout', '-q', '-b', 'side']);
  commit(dir, { 'f.txt': splice(f, 2, 1, 'S2') }, 'feat: side part', { refs: [1] });
  git(dir, ['checkout', '-q', 'main']);
  commit(dir, { 'f.txt': splice(f, 8, 1, 'M8') }, 'feat: main part', { refs: [1] });
  mergeBranch(dir, 'side', {}, 'merge: side');
  const r = att(dir, 1, ['f.txt:2-2']);
  eq('attribute non-linear: ineligible, not attributed', [r.eligible, r.reason, r.claims[0].attributed], [false, 'non-linear', false]);
}

// --- end-to-end: the CLI ---------------------------------------------------------
function cli(args) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], { env: GIT_ENV, stdio: 'pipe', encoding: 'utf8' });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.status, json: JSON.parse(String(e.stdout)) };
  }
}

{
  const { dir, f } = baseRepo();
  const t = splice(f, 3, 2, 'T3', 'T4');
  commit(dir, { 'f.txt': t }, 'feat: ticket', { refs: [1] });
  const c3 = commit(dir, { 'f.txt': splice(t, 3, 1, 'M3') }, 'feat: later ticket', { refs: [2] });
  const indexFile = path.join(dir, '..', path.basename(dir) + '-index.json');
  tmpDirs.push(indexFile);

  const idx = cli(['index', '--repo', dir]);
  fs.writeFileSync(indexFile, JSON.stringify(idx.json));
  eq('cli index: exit 0, head and ticket map', [idx.code, idx.json.head, Object.keys(idx.json.byTicket).sort()], [0, head(dir), ['1', '2']]);

  const fpRun = cli(['fastpath', '--repo', dir, '--index', indexFile, '1', '2']);
  eq('cli fastpath --index: one entry per ticket', [fpRun.code, fpRun.json.shallow, fpRun.json.tickets.map((x) => [x.ticket, x.class, x.reason])],
    [0, false, [[1, 'changed', 'touching-hunk'], [2, 'unchanged', null]]]);

  const noIndex = cli(['fastpath', '--repo', dir, '1']);
  eq('cli fastpath without --index scans itself', noIndex.json.tickets[0].reason, 'touching-hunk');

  const attRun = cli(['attribute', '--repo', dir, '--index', indexFile, '--ticket', '1', '--claim', 'f.txt:3-3', '--claim', 'f.txt:9-10']);
  eq('cli attribute --index: claims in order', [attRun.code, attRun.json.eligible, attRun.json.claims.map((x) => [x.spec, x.attributed, x.evolvedBy])],
    [0, true, [['f.txt:3-3', true, [2]], ['f.txt:9-10', false, []]]]);
  eq('cli attribute: producer carries sha and refs', attRun.json.claims[0].producers, [{ sha: c3, refs: [2] }]);

  commit(dir, { 'other.txt': 'moves HEAD\n' }, 'chore: moves HEAD');
  const stale = cli(['fastpath', '--repo', dir, '--index', indexFile, '1']);
  eq('cli stale --index: exit 2 with an error', [stale.code, /stale/.test(stale.json.error)], [2, true]);
  const staleAtt = cli(['attribute', '--repo', dir, '--index', indexFile, '--ticket', '1', '--claim', 'f.txt:3-3']);
  eq('cli attribute stale --index: exit 2', staleAtt.code, 2);

  fs.writeFileSync(indexFile, '{not json');
  eq('cli malformed --index file: exit 2', cli(['fastpath', '--repo', dir, '--index', indexFile, '1']).code, 2);
}

// usage errors exit 2 with a JSON error
{
  const { dir } = baseRepo();
  eq('cli no subcommand: exit 2', cli([]).code, 2);
  eq('cli unknown subcommand: exit 2', cli(['bogus', '--repo', dir]).code, 2);
  eq('cli fastpath without tickets: exit 2', cli(['fastpath', '--repo', dir]).code, 2);
  eq('cli fastpath non-numeric ticket: exit 2', cli(['fastpath', '--repo', dir, 'abc']).code, 2);
  eq('cli attribute without --ticket: exit 2', cli(['attribute', '--repo', dir, '--claim', 'f.txt:1-1']).code, 2);
  eq('cli attribute bad claim: exit 2', cli(['attribute', '--repo', dir, '--ticket', '1', '--claim', 'nope']).code, 2);
  eq('cli unknown flag: exit 2', cli(['index', '--repo', dir, '--bogus']).code, 2);
  eq('cli --repo without a value: exit 2', cli(['index', '--repo']).code, 2);
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-audit-walk-norepo-'));
  tmpDirs.push(notRepo);
  eq('cli not a repo: exit 2', cli(['index', '--repo', notRepo]).code, 2);
}

// --- review fixes -----------------------------------------------------------------
// W1: a saved index feeds git argv, so every sha and number in it is validated.
{
  const { dir, f } = baseRepo();
  commit(dir, { 'f.txt': splice(f, 3, 1, 'T3') }, 'feat: ticket', { refs: [1] });
  const good = buildTrailerIndex(dir);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'keep me\n');
  const sha = good.byTicket['1'][0];
  const bad = {
    'option-like sha in byTicket': { ...good, byTicket: { 5: ['--output=' + victim] } },
    'option-like sha in refsBySha': { ...good, refsBySha: { ['--output=' + victim]: [5] } },
    'non-numeric ticket key': { ...good, byTicket: { 'x': [sha] } },
    'non-numeric refs value': { ...good, refsBySha: { [sha]: ['--oops'] } },
    'short sha in byTicket': { ...good, byTicket: { 1: [sha.slice(0, 12)] } },
    'byTicket value not an array': { ...good, byTicket: { 1: sha } },
  };
  for (const [name, index] of Object.entries(bad)) {
    assert.throws(() => fastPath(dir, 5, index), /malformed/, name); passed++;
    assert.throws(() => attribute(dir, 5, ['f.txt:1-1'], index), /malformed/, name); passed++;
  }
  assert.throws(() => fastPath(dir, 1, { ...good, head: '--output=' + victim }), /malformed/); passed++;
  eq('malformed index never reaches git: victim intact', fs.readFileSync(victim, 'utf8'), 'keep me\n');
  eq('a well formed index still works', fastPath(dir, 1, good).class, 'unchanged');
}

// W2: fastpath and attribute agree when a foreign commit touches a deletion anchor
{
  const { dir, f } = baseRepo();
  const t = splice(f, 5, 2); // ticket deletes a5-a6: anchor after line 4
  commit(dir, { 'f.txt': t }, 'feat: delete', { refs: [1] });
  const m = splice(t, 4, 1, 'X4');
  commit(dir, { 'f.txt': m }, 'fix: foreign edit at the anchor', { refs: [6] });
  commit(dir, { 'f.txt': splice(m, 8, 1, 'T8') }, 'feat: second', { refs: [1] });
  const fpr = fp(dir, 1);
  const atr = att(dir, 1, ['f.txt:4-4']);
  eq('anchorGuard: fastpath guard, not evolved-eligible', [fpr.class, fpr.reason, fpr.evolvedEligible], ['changed', 'guard', false]);
  eq('anchorGuard: attribute ineligible with the same reason', [atr.eligible, atr.reason], [false, 'guard']);
  eq('anchorGuard: the two agree on eligibility', fpr.evolvedEligible, atr.eligible);
}
// a chain guard alone (no anchor involved) stays evolved-eligible in both
{
  const { dir, f } = baseRepo();
  const t = splice(f, 2, 1, 'T2');
  commit(dir, { 'f.txt': t }, 'feat: first', { refs: [1] });
  const mid = splice(t, 9, 1, 'X9');
  commit(dir, { 'f.txt': mid }, 'fix: foreign edit in the same file', { refs: [6] });
  commit(dir, { 'f.txt': splice(mid, 5, 1, 'T5') }, 'feat: second', { refs: [1] });
  eq('chain guard only: evolved-eligible in both', [fp(dir, 1).evolvedEligible, att(dir, 1, ['f.txt:2-2']).eligible], [true, true]);
}

// I1: a ticket whose commits touch no files is vacuously unchanged
{
  const { dir } = baseRepo();
  commit(dir, {}, 'chore: empty ticket commit', { refs: [1] });
  commit(dir, { 'other.txt': 'later\n' }, 'chore: unrelated work');
  const r = fp(dir, 1);
  eq('fastPath no files: unchanged, files empty', [r.class, r.reason, r.files], ['unchanged', null, []]);
  const base = baseRepo();
  commit(base.dir, {}, 'chore: first', { refs: [1] });
  commit(base.dir, { 'f.txt': splice(base.f, 3, 1, 'X') }, 'fix: foreign', { refs: [6] });
  commit(base.dir, {}, 'chore: second', { refs: [1] });
  eq('fastPath no files: no whole-tree guard hit', fp(base.dir, 1).class, 'unchanged');
}


cleanup();
console.log(`✓ audit-walk: ${passed} assertions passed`);
