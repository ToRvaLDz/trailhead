#!/usr/bin/env node
// Tests for templates/trailhead-auto-queue.js. Run: node auto-queue.test.js
// No framework: plain asserts, same style as uat-backfill.test.js.
//
// Layers covered:
//   1. buildQueue() / main() against a fake tracker behind an injected `gh`
//      runner that honours the frontier search filter and the paused-claims read.
//   2. End-to-end: the script itself with a fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-auto-queue.js');
const { main, buildQueue, RUN_SEARCH, NEEDS_YOU } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- fake tracker ------------------------------------------------------------
// issue: { number, title, labels:[names], assignee: 'me'|null, state }
function makeTracker(init = {}) {
  const t = { issues: init.issues || [], failOn: init.failOn || null, badJson: init.badJson || null, limit: init.limit || 1000, calls: [] };
  const res = (stdout, status = 0) => ({ status, stdout, stderr: status ? 'forced failure' : '' });
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    if (args[0] !== 'issue' || args[1] !== 'list') return res('', 1);
    const want = [];
    let search = '';
    let assignee = null;
    let state = 'open';
    let limit = 1000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--label') want.push(args[++i]);
      else if (args[i] === '--search') search = args[++i];
      else if (args[i] === '--assignee') assignee = args[++i];
      else if (args[i] === '--state') state = args[++i];
      else if (args[i] === '--limit') limit = Number(args[++i]);
    }
    const kind = want.includes('trailhead:map') ? 'maps' : want.includes('trailhead:paused') ? 'paused' : 'frontier';
    if (t.failOn === kind) return res('', 1);
    if (t.badJson && t.badJson === kind) return res('not json');
    const excl = [...search.matchAll(/-label:(\S+)/g)].map((m) => m[1]);
    const noAssignee = /no:assignee/.test(search);
    let rows = t.issues.filter((i) => i.state !== 'closed' && state === 'open')
      .filter((i) => want.every((l) => i.labels.includes(l)))
      .filter((i) => !excl.some((l) => i.labels.includes(l)))
      .filter((i) => !noAssignee || !i.assignee)
      .filter((i) => assignee !== '@me' || i.assignee === 'me');
    rows = rows.slice(0, t.limit === 1000 ? limit : t.limit);
    return res(JSON.stringify(rows.map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((name) => ({ name })) }))));
  };
  return t;
}

function run(t, argv) {
  let out = '';
  let errOut = '';
  const code = main(argv, { gh: t.gh, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } } });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json, errOut };
}

const map = (n, extra = {}) => ({ number: n, title: `Map ${n}`, labels: ['trailhead:map'], ...extra });
const tk = (n, type, labels, extra = {}) => ({ number: n, title: `T${n}`, labels: ['trailhead:ticket', `trailhead:${type}`, ...labels], assignee: null, ...extra });
const nums = (list) => list.map((x) => x.number);

const base = () => [
  map(5), map(2), map(9, { state: 'closed' }),
  tk(30, 'build', ['trailhead:map-5']),
  tk(21, 'bug', ['trailhead:map-2']),
  tk(11, 'task', ['trailhead:map-2']),
  tk(40, 'research', ['trailhead:whiteboard']),
  tk(31, 'decision', ['trailhead:map-5']),
  tk(50, 'build', ['trailhead:map-9']), // closed map: ignored
  tk(51, 'build', []), // no scope label: ignored
  tk(52, 'build', ['trailhead:map-2', 'trailhead:whiteboard']), // map wins
  tk(60, 'build', ['trailhead:map-2', 'trailhead:blocked']), // blocked: never queued
  tk(61, 'build', ['trailhead:map-5', 'trailhead:paused']),
  tk(62, 'build', ['trailhead:map-5', 'trailhead:unverified']),
  tk(63, 'build', ['trailhead:map-5'], { assignee: 'someone' }),
  tk(70, 'build', ['trailhead:map-2', 'trailhead:map-5']), // two open maps: drift
];

// --- ordering: everything ----------------------------------------------------
{
  const t = makeTracker({ issues: base() });
  const r = run(t, ['queue', '--scope', 'everything', '--repo', 'o/r']);
  ok('exit 0, one JSON line', r.code === 0 && r.json.status === 'ok' && r.out.trim().split('\n').length === 1);
  ok('groups: maps ascending, whiteboard last', JSON.stringify(r.json.groups.map((g) => g.map)) === '[2,5,null]' && r.json.groups[2].kind === 'whiteboard');
  ok('tickets ascending inside a group, map label wins over whiteboard', JSON.stringify(nums(r.json.groups[0].tickets)) === '[11,21,52]');
  ok('map 5 group', JSON.stringify(nums(r.json.groups[1].tickets)) === '[30,31]');
  ok('whiteboard group', JSON.stringify(nums(r.json.groups[2].tickets)) === '[40]');
  ok('each ticket carries its type', r.json.groups[0].tickets[0].type === 'task' && r.json.groups[0].tickets[1].type === 'bug' && r.json.groups[1].tickets[1].type === 'decision');
  const all = r.json.groups.flatMap((g) => nums(g.tickets));
  ok('blocked/unverified/paused/assigned never queued', [60, 61, 62, 63].every((n) => !all.includes(n)));
  ok('closed-map and unlabelled tickets ignored', !all.includes(50) && !all.includes(51));
  ok('multi-map-label ticket is drift, not queued', JSON.stringify(nums(r.json.drift)) === '[70]' && !all.includes(70));
  ok('next is the lowest ticket of the first map', r.json.next.number === 11 && r.json.next.map === 2);
  ok('queue reads: frontier uses the canonical search', t.calls.some((c) => c.includes('--label trailhead:ticket') && c.includes('no:assignee -label:trailhead:blocked -label:trailhead:unverified -label:trailhead:paused') && c.includes('--limit 1000') && c.includes('--json number,title,labels')));
  ok('queue reads: open maps and caller paused claims', t.calls.some((c) => c.includes('--label trailhead:map --state open') && c.includes('--json number,title')) && t.calls.some((c) => c.includes('--label trailhead:paused') && c.includes('--assignee @me')));
}

// --- skip / next -------------------------------------------------------------
{
  const t = makeTracker({ issues: base() });
  let r = run(t, ['queue', '--scope', 'everything', '--skip', '11,21']);
  ok('skipped tickets dropped, next stays in the current map', JSON.stringify(nums(r.json.groups[0].tickets)) === '[52]' && r.json.next.number === 52);
  r = run(t, ['queue', '--scope', 'everything', '--skip', '11,21,52']);
  ok('next moves to the next map only when the group is empty after skip', r.json.next.number === 30 && r.json.next.map === 5);
  r = run(t, ['queue', '--scope', 'everything', '--skip', '11,21,52,30,31']);
  ok('whiteboard only after every map', r.json.next.number === 40 && r.json.next.map === null);
  r = run(t, ['queue', '--scope', 'everything', '--skip', '11,21,52,30,31,40']);
  ok('drained scope has next null', r.code === 0 && r.json.next === null);
}

// --- single scopes -----------------------------------------------------------
{
  const t = makeTracker({ issues: base() });
  let r = run(t, ['queue', '--scope', 'map:5']);
  ok('map:<n> yields only that map', r.json.groups.length === 1 && r.json.groups[0].map === 5 && r.json.next.number === 30);
  ok('map:<n> drift is limited to that map', JSON.stringify(nums(r.json.drift)) === '[70]');
  r = run(t, ['queue', '--scope', 'whiteboard']);
  ok('whiteboard scope yields only the whiteboard group', r.json.groups.length === 1 && r.json.groups[0].kind === 'whiteboard' && r.json.next.number === 40 && r.json.drift.length === 0);
  r = run(t, ['queue', '--scope', 'map:9']);
  ok('a closed map is an error naming it', r.code === 1 && r.json.status === 'error' && /9/.test(r.json.reason));
  r = run(t, ['queue', '--scope', 'map:77']);
  ok('an unknown map is an error naming it', r.code === 1 && r.json.status === 'error' && /77/.test(r.json.reason));
  ok('a non-map issue is an error', run(makeTracker({ issues: [tk(8, 'build', ['trailhead:map-2'])] }), ['queue', '--scope', 'map:8']).code === 1);
}

// --- resume ------------------------------------------------------------------
{
  const issues = [
    map(2), map(5),
    tk(14, 'build', ['trailhead:map-5', 'trailhead:paused'], { assignee: 'me' }),
    tk(12, 'bug', ['trailhead:map-5', 'trailhead:paused'], { assignee: 'me' }),
    tk(13, 'build', ['trailhead:map-2', 'trailhead:paused'], { assignee: 'other' }),
    tk(15, 'task', ['trailhead:whiteboard', 'trailhead:paused'], { assignee: 'me' }),
    tk(30, 'build', ['trailhead:map-5']),
  ];
  const t = makeTracker({ issues });
  let r = run(t, ['queue', '--scope', 'everything']);
  ok('resume lists the caller paused tickets per group, ascending', JSON.stringify(nums(r.json.groups[1].resume)) === '[12,14]' && r.json.groups[0].resume.length === 0 && JSON.stringify(nums(r.json.groups[2].resume)) === '[15]');
  ok('paused tickets are not in the work queue', JSON.stringify(nums(r.json.groups[1].tickets)) === '[30]');
  r = run(t, ['queue', '--scope', 'map:5']);
  ok('resume is scoped', r.json.groups.length === 1 && JSON.stringify(nums(r.json.groups[0].resume)) === '[12,14]');
}

// --- needs-you tickets are skipped by the run ---------------------------------
{
  const issues = [
    map(2),
    tk(11, 'build', ['trailhead:map-2']),
    tk(12, 'build', ['trailhead:map-2', 'trailhead:needs-you']),
    tk(13, 'build', ['trailhead:map-2', 'trailhead:paused', 'trailhead:needs-you'], { assignee: 'me' }),
    tk(14, 'build', ['trailhead:map-2', 'trailhead:paused'], { assignee: 'me' }),
  ];
  const t = makeTracker({ issues });
  let r = run(t, ['queue', '--scope', 'everything']);
  ok('needs-you ticket is not queued nor next', JSON.stringify(nums(r.json.groups[0].tickets)) === '[11]' && r.json.next.number === 11);
  ok('needs-you ticket is never auto-resumed', JSON.stringify(nums(r.json.groups[0].resume)) === '[14]');
  ok('frontier read sends the needs-you exclusion', t.calls.some((c) => c.includes('--label trailhead:ticket') && c.includes('-label:trailhead:paused -label:trailhead:needs-you')));
  r = run(t, ['scopes']);
  ok('scopes does not count a needs-you ticket', r.json.maps[0].frontier === 1);
  ok('RUN_SEARCH extends the canonical frontier', RUN_SEARCH.endsWith(' -label:trailhead:needs-you') && NEEDS_YOU === 'trailhead:needs-you');
  // defence against a lagging search index: the pure builder drops it too
  const q = buildQueue([{ number: 2, title: 'm' }],
    [{ number: 5, title: 'a', labels: ['trailhead:map-2', 'trailhead:needs-you'] }, { number: 6, title: 'b', labels: ['trailhead:map-2'] }],
    [{ number: 7, title: 'c', labels: ['trailhead:map-2', 'trailhead:needs-you'] }], 'everything', []);
  ok('buildQueue drops needs-you from frontier and resume', nums(q.groups[0].tickets).join() === '6' && q.groups[0].resume.length === 0 && q.next.number === 6);
}

// --- fail closed -------------------------------------------------------------
{
  const many = [map(2)];
  for (let i = 0; i < 1000; i++) many.push(tk(100 + i, 'build', ['trailhead:map-2']));
  const t = makeTracker({ issues: many });
  const r = run(t, ['queue', '--scope', 'everything']);
  ok('a frontier read at the limit fails closed', r.code === 1 && r.json.status === 'error' && /incomplete/.test(r.json.reason) && !r.json.groups);
  const s = run(t, ['scopes']);
  ok('scopes fails closed on truncation too', s.code === 1 && s.json.status === 'error' && /incomplete/.test(s.json.reason));
  const maps = [];
  for (let i = 1; i <= 1000; i++) maps.push(map(i));
  ok('a truncated map list fails closed', run(makeTracker({ issues: maps }), ['queue', '--scope', 'everything']).code === 1);
}
for (const kind of ['maps', 'frontier', 'paused']) {
  let r = run(makeTracker({ issues: base(), failOn: kind }), ['queue', '--scope', 'everything']);
  ok(`gh failure on ${kind} read is an error`, r.code === 1 && r.json.status === 'error');
  r = run(makeTracker({ issues: base(), badJson: kind }), ['queue', '--scope', 'everything']);
  ok(`bad JSON on ${kind} read is an error`, r.code === 1 && r.json.status === 'error');
}

// --- scopes ------------------------------------------------------------------
{
  const t = makeTracker({ issues: base() });
  const r = run(t, ['scopes', '--repo', 'o/r']);
  ok('scopes: open maps ascending with frontier counts', r.code === 0 && JSON.stringify(r.json.maps) === JSON.stringify([
    { number: 2, title: 'Map 2', frontier: 3 }, { number: 5, title: 'Map 5', frontier: 2 }]));
  ok('scopes: whiteboard count', r.json.whiteboard.frontier === 1);
  ok('scopes: passes -R', t.calls.every((c) => c.includes('-R o/r')));
}

// --- pure buildQueue ---------------------------------------------------------
{
  const q = buildQueue([{ number: 1, title: 'a' }], [{ number: 3, title: 'x', labels: ['trailhead:map-1', 'trailhead:build'] }], [], 'everything', []);
  ok('buildQueue accepts string labels', q.groups[0].tickets[0].type === 'build' && q.next.number === 3);
  ok('buildQueue reports a bad scope', buildQueue([], [], [], 'map:4', []).error);
}

// --- usage -------------------------------------------------------------------
for (const argv of [[], ['bogus'], ['queue'], ['queue', '--scope', 'nope'], ['queue', '--scope', 'map:x'], ['queue', '--scope', 'everything', '--skip', 'a,b'],
  ['queue', '--scope'], ['scopes', '--bogus'], ['scopes', '--repo', 'nope']]) {
  const t = makeTracker();
  const r = run(t, argv);
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2 && t.calls.length === 0);
}

// --- end-to-end with a fake gh on PATH -----------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-queue-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const script = `#!/bin/sh
case "$*" in
  *"--label trailhead:map "*) echo '[{"number":2,"title":"M"}]' ;;
  *"--label trailhead:paused"*) echo '[]' ;;
  *) echo '[{"number":7,"title":"T","labels":[{"name":"trailhead:map-2"},{"name":"trailhead:build"}]}]' ;;
esac
`;
  fs.writeFileSync(path.join(binDir, 'gh'), script, { mode: 0o755 });
  const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
  const res = spawnSync('node', [scriptPath, 'queue', '--scope', 'map:2'], { encoding: 'utf8', env });
  const j = JSON.parse(res.stdout.trim());
  ok('e2e: queue prints one JSON line with next', res.status === 0 && j.status === 'ok' && j.next.number === 7 && j.next.type === 'build');
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const bad = spawnSync('node', [scriptPath, 'queue', '--scope', 'everything'], { encoding: 'utf8', env });
  ok('e2e: gh failing exits 1 with an error line', bad.status === 1 && JSON.parse(bad.stdout.trim()).status === 'error');
  ok('e2e: usage error exits 2', spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' }).status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`auto-queue.test.js: ${passed} checks passed`);
