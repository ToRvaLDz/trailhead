#!/usr/bin/env node
// Tests for templates/trailhead-facet-touch.js. Run: node facet-touch.test.js
// No framework: plain asserts, same style as audit-walk.test.js.
//
// Layers:
//   1. check against a synthetic git repo built in os.tmpdir() and a fake tracker
//      behind an injected `gh` (the only mocked boundary).
//   2. check with --before / --comment-file (the dispositions a change proves).
//   3. restamp against the same fake tracker (refusals, concurrent edit, the write).
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const mod = require(path.resolve(__dirname, '..', '..', 'templates', 'trailhead-facet-touch.js'));

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}`);
  passed++;
};

// --- synthetic repo ------------------------------------------------------------
const GIT_ENV = { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' };
const GIT_FLAGS = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
  '-c', 'user.name=Facet Test', '-c', 'user.email=facet@example.com',
];
const tmpDirs = [];
let clock = 0;

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...GIT_FLAGS, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(dir, files, subject, refs) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) fs.rmSync(abs, { force: true });
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
  }
  git(dir, ['add', '-A']);
  clock += 60;
  const date = new Date(Date.UTC(2021, 0, 1) + clock * 1000).toISOString();
  const msg = refs ? `${subject}\n\nRefs: #${refs}` : subject;
  execFileSync('git', ['-C', dir, ...GIT_FLAGS, 'commit', '-q', '--allow-empty', '-m', msg], {
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-facet-touch-test-'));
  tmpDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  const s = {};
  s.dir = dir;
  s.c0 = commit(dir, { 'src/a.js': 'a0\n', 'src/b.js': 'b0\n', 'src/old.js': 'old\n', 'src/gone.js': 'gone\n', 'src/keep.js': 'keep\n' }, 'base');
  s.c1 = commit(dir, { 'src/a.js': 'a1\n' }, 'touch a', 395);
  s.c2 = commit(dir, { 'src/b.js': 'b1\n' }, 'other ticket', 3950);
  s.c3 = commit(dir, { 'src/old.js': null, 'src/new.js': 'old\n', 'src/gone.js': null }, 'rename and delete', 395);
  s.c4 = commit(dir, { 'NOTES.md': 'notes\n' }, 'floor commit');
  return s;
}

// --- fake tracker ----------------------------------------------------------------
function makeTracker(body) {
  const t = { body, updatedAt: 'T1', edits: 0, views: 0, writes: [], onView: null, tmpSeen: [] };
  t.set = (b) => { t.body = b; t.updatedAt = 'T' + (Number(t.updatedAt.slice(1)) + 1); };
  t.gh = (args) => {
    const sub = args.slice(0, 2).join(' ');
    if (sub === 'issue view') {
      t.views += 1;
      if (t.onView) t.onView(t, t.views);
      return { status: 0, stdout: JSON.stringify({ body: t.body, updatedAt: t.updatedAt }), stderr: '' };
    }
    if (sub === 'issue edit') {
      const file = args[args.indexOf('--body-file') + 1];
      t.tmpSeen.push(file);
      const text = fs.readFileSync(file, 'utf8');
      t.writes.push(text);
      t.body = text;
      t.edits += 1;
      t.updatedAt = 'T' + (Number(t.updatedAt.slice(1)) + 1);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (sub === 'api graphql') {
      return { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { userContentEdits: { totalCount: t.edits } } } } }), stderr: '' };
    }
    if (sub === 'repo view') return { status: 0, stdout: 'o/r\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected: ' + args.join(' ') };
  };
  return t;
}

function facet(name, stamp, cites, text = 'Describes the module.') {
  const cl = cites ? `Cites: ${cites.map((c) => '`' + c + '`').join(', ')}\n\n` : '';
  return `## ${name}\n\n${stamp ? `_as of ${stamp}_\n\n` : ''}${text}\n\n${cl}`;
}
const bodyOf = (...facets) => '# Codebase\n\nIntro line for the map of the codebase.\n\n' + facets.join('');

const fakeGuard = { scan: () => null };

function run(argv, t, extra = {}) {
  const chunks = [];
  const code = mod.main(argv, { gh: t.gh, stdout: { write: (s) => chunks.push(s) }, guard: fakeGuard, ...extra });
  const out = chunks.join('');
  return { code, out, json: JSON.parse(out.trim().split('\n').pop()) };
}

const base = (s, extra = []) => ['check', '--repo', s.dir, '--ticket', '395', '--issue', '5', '--gh-repo', 'o/r', '--floor', s.c4, ...extra];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-facet-touch-files-'));
tmpDirs.push(scratch);
let fileSeq = 0;
function save(text) { const f = path.join(scratch, `f${fileSeq++}.txt`); fs.writeFileSync(f, text); return f; }
const names = (list) => list.map((x) => x.name).sort();

const S = mkrepo();

// --- check: touched set, flagged vs uncheckable --------------------------------------
{
  const t = makeTracker(bodyOf(
    facet('Alpha', S.c0, ['src/a.js']),
    facet('Beta', S.c0, ['src/b.js']),
    facet('Gamma', null, ['src/a.js']),
    facet('Delta', S.c0, ['nowhere/x.js']),
    facet('Legacy', S.c0, null, 'Reads `src/new.js` and `src/a.js:3-9`.'),
    facet('Renamed', S.c0, ['src/old.js']),
    facet('Deleted', S.c0, ['src/gone.js']),
  ));
  const r = run(base(S), t);
  eq('check: exit 0', r.code, 0);
  eq('check: one JSON line', r.out.trim().split('\n').length, 1);
  eq('check: commits are the anchored Refs set (#3950 excluded)', r.json.commits, [S.c1, S.c3]);
  eq('check: touched covers rename (both sides) and deletion', r.json.touched, ['src/a.js', 'src/gone.js', 'src/new.js', 'src/old.js']);
  eq('check: flagged facets', names(r.json.flagged), ['Alpha', 'Deleted', 'Legacy', 'Renamed']);
  const legacy = r.json.flagged.find((f) => f.name === 'Legacy');
  eq('check: legacy facet falls back to backticked tokens, line suffix stripped', legacy.cites, ['src/a.js', 'src/new.js']);
  eq('check: unstamped and no-paths are uncheckable, not flagged', r.json.uncheckable.map((u) => `${u.name}:${u.reason}`).sort(), ['Delta:no-paths', 'Gamma:unstamped']);
  eq('check: an untouched facet (Beta) is neither flagged nor uncheckable', names(r.json.flagged).includes('Beta') || names(r.json.uncheckable).includes('Beta'), false);
  eq('check: all flagged are pending below the floor', names(r.json.pending), ['Alpha', 'Deleted', 'Legacy', 'Renamed']);
  ok('check: audit line points to /trailhead:audit', /\/trailhead:audit/.test(r.json.audit) && /Gamma/.test(r.json.audit) && /Delta/.test(r.json.audit));
  ok('check: bodyHash is a sha256', /^[0-9a-f]{64}$/.test(r.json.bodyHash));
}

// --- check: coverage by floor ancestry ----------------------------------------------
{
  const t = makeTracker(bodyOf(facet('Alpha', S.c4, ['src/a.js']), facet('Late', S.c3, ['src/a.js'])));
  const r = run(base(S), t);
  eq('check: stamp at the floor is covered', r.json.flagged.find((f) => f.name === 'Alpha').covered, true);
  eq('check: stamp before the floor is not covered', r.json.flagged.find((f) => f.name === 'Late').covered, false);
  eq('check: pending lists only the uncovered', names(r.json.pending), ['Late']);
  eq('check: no uncheckable gives a null audit', r.json.audit, null);
  const pr = run(base(S).map((a) => (a === S.c4 ? S.c1 : a)), t);
  eq('check: a fork-point floor clears a stamp at the fork point', names(pr.json.pending), []);
}

// --- check: live read, usage errors, duplicates, bad stamps ---------------------------
{
  const t = makeTracker(bodyOf(facet('Alpha', S.c0, ['src/a.js'])));
  eq('live: first run pending', names(run(base(S), t).json.pending), ['Alpha']);
  t.set(bodyOf(facet('Alpha', S.c4, ['src/a.js'])));
  eq('live: the body changed between calls is seen', names(run(base(S), t).json.pending), []);
  const noFloor = run(['check', '--repo', S.dir, '--ticket', '395', '--issue', '5'], t);
  eq('usage: no --floor is exit 2', noFloor.code, 2);
  eq('usage: --floor error is JSON', typeof noFloor.json.error, 'string');
  const none = run(['check', '--repo', S.dir, '--ticket', '77', '--issue', '5', '--floor', S.c4], t);
  eq('check: an empty commit set is exit 2 status error', [none.code, none.json.status], [2, 'error']);
  const badFloor = run(['check', '--repo', S.dir, '--ticket', '395', '--issue', '5', '--floor', 'nonsense'], t);
  eq('check: an unresolvable floor is exit 2', badFloor.code, 2);
  t.set(bodyOf(facet('Dup', S.c4, ['src/a.js']), facet('Dup', S.c4, ['src/b.js'])));
  const dup = run(base(S), t);
  ok('check: duplicate facet names fail closed', dup.code === 2 && dup.json.status === 'error' && /Dup/.test(dup.json.error));
  t.set(bodyOf(facet('Unknown', 'deadbee', ['src/a.js'])));
  eq('check: an unknown stamp is never covered', run(base(S), t).json.flagged[0].covered, false);
  const same = bodyOf(facet('Alpha', S.c0, ['src/a.js']));
  t.set(same);
  const h1 = run(base(S), t).json.bodyHash;
  t.set(same + 'extra line\n');
  ok('check: bodyHash changes with the body', run(base(S), t).json.bodyHash !== h1);
  t.set('');
  const empty = run(base(S), t);
  eq('check: a failed or empty read is exit 2', empty.code, 2);
}

// --- check: text hash ignores the stamp line ------------------------------------------
{
  const t = makeTracker(bodyOf(facet('Alpha', S.c0, ['src/a.js'])));
  const h0 = run(base(S), t).json.flagged[0].textHash;
  t.set(bodyOf(facet('Alpha', S.c4, ['src/a.js'])));
  eq('hash: a stamp-only move keeps the text hash', run(base(S), t).json.flagged[0].textHash, h0);
  t.set(bodyOf(facet('Alpha', S.c4, ['src/a.js'], 'Other words.')));
  ok('hash: a text change changes it', run(base(S), t).json.flagged[0].textHash !== h0);
}

// --- check: comment lines and --before ---------------------------------------------
const PATCHED = (n) => `Codebase: ${n} patched`;
const RESTAMPED = (n, f = 'src/a.js') => `Codebase: ${n} restamped, no change (${f}: only a comment changed)`;
const withComment = (lines, before) => ['--comment-file', save(lines.join('\n') + '\n'), ...(before ? ['--before', before] : [])];
const snapshot = (t) => save(JSON.stringify(run(base(S), t).json));
const problems = (r, name) => (r.json.pending.find((p) => p.name === name) || { problems: [] }).problems;

{
  // Without --before: exactly one well-formed line per flagged facet.
  const t = makeTracker(bodyOf(facet('Alpha', S.c4, ['src/a.js'])));
  eq('lines: a patched line passes', names(run(base(S, withComment([PATCHED('Alpha')])), t).json.pending), []);
  eq('lines: a restamped line with a touched file and reason passes', names(run(base(S, withComment([RESTAMPED('Alpha')])), t).json.pending), []);
  eq('lines: a missing line is pending', names(run(base(S, withComment(['nothing here'])), t).json.pending), ['Alpha']);
  eq('lines: a duplicate line is pending', names(run(base(S, withComment([PATCHED('Alpha'), PATCHED('Alpha')])), t).json.pending), ['Alpha']);
  eq('lines: a restamp for a file the facet does not cite is pending', names(run(base(S, withComment([RESTAMPED('Alpha', 'src/b.js')])), t).json.pending), ['Alpha']);
  eq('lines: a restamp without a reason is pending', names(run(base(S, withComment(['Codebase: Alpha restamped, no change (src/a.js: )'])), t).json.pending), ['Alpha']);
  ok('lines: lineProblems is reported', run(base(S, withComment(['x'])), t).json.lineProblems.length === 1);
}

{
  // An already-covered facet with an invented patched line stays pending.
  const t = makeTracker(bodyOf(facet('Alpha', S.c4, ['src/a.js'])));
  const before = snapshot(t);
  eq('before: invented patched line on unchanged text is pending', names(run(base(S, withComment([PATCHED('Alpha')], before)), t).json.pending), ['Alpha']);
  eq('before: the same facet with a reasoned restamp passes', names(run(base(S, withComment([RESTAMPED('Alpha')], before)), t).json.pending), []);
}

{
  // A stamp-only move: patched is refused, restamped passes.
  const t = makeTracker(bodyOf(facet('Alpha', S.c0, ['src/a.js'])));
  const before = snapshot(t);
  t.set(bodyOf(facet('Alpha', S.c4, ['src/a.js'])));
  eq('before: a stamp-only move with a patched line is pending', names(run(base(S, withComment([PATCHED('Alpha')], before)), t).json.pending), ['Alpha']);
  eq('before: a stamp-only move with a restamped line passes', names(run(base(S, withComment([RESTAMPED('Alpha')], before)), t).json.pending), []);
  // A text patch plus the stamp move: patched passes, restamped is refused.
  t.set(bodyOf(facet('Alpha', S.c4, ['src/a.js'], 'New words about a.')));
  eq('before: changed text with a patched line passes', names(run(base(S, withComment([PATCHED('Alpha')], before)), t).json.pending), []);
  eq('before: changed text with a restamped line is pending', names(run(base(S, withComment([RESTAMPED('Alpha')], before)), t).json.pending), ['Alpha']);
  // Changed text below the floor is not covered.
  t.set(bodyOf(facet('Alpha', S.c3, ['src/a.js'], 'New words about a.')));
  eq('before: patched text but stamp below the floor is pending', names(run(base(S, withComment([PATCHED('Alpha')], before)), t).json.pending), ['Alpha']);
}

{
  // An unchanged facet below the floor with a restamped line stays pending.
  const t = makeTracker(bodyOf(facet('Alpha', S.c0, ['src/a.js'])));
  const before = snapshot(t);
  eq('before: unchanged below the floor, restamped line, is pending', names(run(base(S, withComment([RESTAMPED('Alpha')], before)), t).json.pending), ['Alpha']);
}

{
  // The cite was dropped after the first run: still judged, needs a patched line.
  const t = makeTracker(bodyOf(facet('Alpha', S.c0, ['src/a.js'])));
  const before = snapshot(t);
  t.set(bodyOf(facet('Alpha', S.c4, ['src/keep.js'], 'Now about keep.')));
  eq('before: a dropped cite is still judged', names(run(base(S, withComment(['none'], before)), t).json.pending), ['Alpha']);
  eq('before: a dropped cite needs, and takes, a patched line', names(run(base(S, withComment([PATCHED('Alpha')], before)), t).json.pending), []);
}

{
  // Removed facet: a patched line, no coverage required; a rename needs both names.
  const t = makeTracker(bodyOf(facet('Alpha', S.c0, ['src/a.js']), facet('Other', S.c4, ['src/keep.js'])));
  const before = snapshot(t);
  t.set(bodyOf(facet('Other', S.c4, ['src/keep.js'])));
  eq('before: a removed facet without a line is pending', names(run(base(S, withComment(['none'], before)), t).json.pending), ['Alpha']);
  eq('before: a removed facet with a patched line passes', names(run(base(S, withComment([PATCHED('Alpha')], before)), t).json.pending), []);
  eq('before: a removed facet does not accept a restamp', names(run(base(S, withComment([RESTAMPED('Alpha')], before)), t).json.pending), ['Alpha']);
  t.set(bodyOf(facet('Alpha Two', S.c4, ['src/a.js']), facet('Other', S.c4, ['src/keep.js'])));
  eq('before: a rename with only the old name is pending', names(run(base(S, withComment([PATCHED('Alpha')], before)), t).json.pending), ['Alpha Two']);
  eq('before: a rename needs a patched line for both names', names(run(base(S, withComment([PATCHED('Alpha'), PATCHED('Alpha Two')], before)), t).json.pending), []);
}

{
  // A snapshot of another commit set or floor is refused.
  const t = makeTracker(bodyOf(facet('Alpha', S.c0, ['src/a.js'])));
  const before = snapshot(t);
  const otherFloor = run(base(S, ['--before', before]).map((a) => (a === S.c4 ? S.c3 : a)), t);
  eq('before: another floor is exit 2', otherFloor.code, 2);
  const stale = JSON.parse(fs.readFileSync(before, 'utf8'));
  const f = save(JSON.stringify({ ...stale, commits: [S.c1] }));
  eq('before: another commit set is exit 2', run(base(S, ['--before', f]), t).code, 2);
  const f2 = save(JSON.stringify({ ...stale, ticket: 1 }));
  eq('before: another ticket is exit 2', run(base(S, ['--before', f2]), t).code, 2);
  eq('before: a malformed snapshot is exit 2', run(base(S, ['--before', save('{nope')]), t).code, 2);
}

// --- restamp ------------------------------------------------------------------------
const rbase = (extra) => ['restamp', '--repo', S.dir, '--ticket', '395', '--issue', '5', '--gh-repo', 'o/r', '--facet', 'Alpha', '--stamp', S.c4.slice(0, 12), ...extra];
const REASON = ['--reason', 'src/a.js: only a comment changed'];
const BODY0 = bodyOf(facet('Alpha', S.c0, ['src/a.js', 'src/keep.js'], 'Alpha text line.'), facet('Other', S.c0, ['src/b.js']));

{
  for (const [label, extra] of [
    ['no reason', []],
    ['empty reason', ['--reason', '']],
    ['no colon', ['--reason', 'src/a.js only']],
    ['empty why', ['--reason', 'src/a.js:   ']],
    ['not a touched cite', ['--reason', 'src/keep.js: untouched file']],
    ['a file the facet does not cite', ['--reason', 'src/b.js: cited elsewhere']],
  ]) {
    const t = makeTracker(BODY0);
    const r = run(rbase(extra), t);
    ok(`restamp: ${label} is refused, exit 2, nothing written`, r.code === 2 && t.writes.length === 0 && t.body === BODY0);
  }
  const t = makeTracker(BODY0);
  const unknown = run(rbase(REASON).map((a) => (a === 'Alpha' ? 'Nope' : a)), t);
  ok('restamp: an unknown facet is refused', unknown.code === 2 && t.writes.length === 0);
  const badStamp = run(rbase(REASON).map((a) => (a === S.c4.slice(0, 12) ? 'zzzz' : a)), t);
  ok('restamp: a bad stamp is refused', badStamp.code === 2 && t.writes.length === 0);
}

{
  // The cite was dropped between the first read and the write: refused on the fresh body.
  const t = makeTracker(BODY0);
  t.onView = (tr, n) => {
    if (n === 2) tr.set(bodyOf(facet('Alpha', S.c0, ['src/keep.js'], 'Alpha text line.'), facet('Other', S.c0, ['src/b.js'])));
  };
  const r = run(rbase(REASON), t);
  ok('restamp: a concurrent edit dropping the cite is refused on the fresh body', r.code === 2 && r.json.status === 'refused' && t.writes.length === 0);
}

{
  const t = makeTracker(BODY0);
  const r = run(rbase(REASON), t);
  eq('restamp: ok exit 0', r.code, 0);
  eq('restamp: prints the Codebase line', r.json, { status: 'restamped', line: 'Codebase: Alpha restamped, no change (src/a.js: only a comment changed)' });
  eq('restamp: one write', t.writes.length, 1);
  const facets = require(path.resolve(__dirname, '..', '..', 'templates', 'trailhead-issue-body.js')).facetsOf;
  const old = facets(BODY0);
  const now = facets(t.writes[0]);
  eq('restamp: the stamp moved (resolved short sha kept as given)', now.find((f) => f.name === 'Alpha').sha, S.c4.slice(0, 12));
  const strip = (txt) => txt.replace(/_as of [0-9a-f]+_/, '').replace(/\s+/g, ' ').trim();
  eq('restamp: the text is unchanged apart from the stamp', strip(now.find((f) => f.name === 'Alpha').text), strip(old.find((f) => f.name === 'Alpha').text));
  eq('restamp: other facets untouched', now.find((f) => f.name === 'Other'), old.find((f) => f.name === 'Other'));
  eq('restamp: the preamble is untouched', t.writes[0].split('## ')[0], BODY0.split('## ')[0]);
  const after = run(base(S, withComment([r.json.line])), t);
  ok('restamp: check then clears the facet', names(after.json.pending).length === 0 && after.json.flagged[0].covered === true);
}

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`✓ facet-touch: ${passed} assertions passed`);
