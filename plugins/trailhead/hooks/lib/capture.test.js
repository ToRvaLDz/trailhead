#!/usr/bin/env node
// Tests for templates/trailhead-capture.js (#332). Run: node capture.test.js
// No framework: plain asserts, same style as needs-you.test.js.
//
// Layers covered:
//   1. Seams: parseArgs, buildIssue, parseAllowlist, checkTrust, resolveDestination,
//      findDuplicate.
//   2. main() against a fake tracker behind an injected `gh` and `sleep`.
//   3. End-to-end: the script itself with a fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-capture.js');
const guardYml = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-label-guard.yml');
const cap = require(scriptPath);
const { main, parseArgs, buildIssue, parseAllowlist, checkTrust, resolveDestination, findDuplicate } = cap;

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const fakeGuard = { scan: (text) => (/ghp_[A-Za-z0-9]{20,}/.test(text) ? 'github token' : null) };
const TYPE_LABELS = ['decision', 'research', 'prototype', 'build', 'bug', 'task'].map((t) => `trailhead:${t}`);
const URL_BASE = 'https://github.com/o/r/issues';

// --- fake tracker ------------------------------------------------------------
// issues: number -> { state, title, labels:[names] } for pre-existing issues (maps, origins).
// Options: login (null = unreadable identity), perms {login: permission}, allowlist (undefined =
// unreadable variable), labeller (actor of the labeled events), eventsFail, dropLabels (labels the
// server loses), eventsLag (count of leading event reads that return an empty list), eventsPartial
// (count of leading reads that show only the first label), lateLabeller (actor of the events
// after the partial reads, default labeller), edgeFail (count of failing edge POSTs), dashFail,
// searchCap, open [{number,body}].
function makeTracker(init = {}) {
  const t = {
    login: 'maint', perms: { maint: 'admin' }, allowlist: undefined, labeller: 'maint', eventsFail: false, eventsLag: 0, eventsPartial: 0, lateLabeller: null, eventReads: 0,
    dropLabels: [], edgeFail: 0, dashFail: false, searchCap: false, open: [], permFail: false,
    issues: { 5: { state: 'OPEN', title: 'Map five', labels: ['trailhead:map'] }, 6: { state: 'CLOSED', title: 'Map six', labels: ['trailhead:map'] } },
    ...init, calls: [], created: [], edges: [], inputs: [], next: 100,
  };
  const res = (stdout, status = 0) => ({ status, stdout, stderr: status ? 'forced failure' : '' });
  const j = (o) => res(JSON.stringify(o));
  t.gh = (args, input) => {
    const line = args.join(' ');
    t.calls.push(line);
    const [a, b] = args;
    if (a === 'label' && b === 'create') return res('');
    if (line.startsWith('api user')) return t.login === null ? res('', 1) : res(t.login + '\n');
    let m = /^api repos\/o\/r\/collaborators\/([^/]+)\/permission/.exec(line);
    if (m) return t.permFail ? res('', 1) : j({ permission: t.perms[m[1]] || 'none', role_name: t.perms[m[1]] || 'none' });
    if (/^api repos\/o\/r\/actions\/variables\/TRAILHEAD_LABEL_ALLOWLIST/.test(line)) return t.allowlist === undefined ? res('', 1) : res(t.allowlist + '\n');
    if (a === 'issue' && b === 'view') {
      const n = Number(args[2]);
      const pre = t.issues[n];
      const made = t.created.find((c) => c.number === n);
      if (made) return j({ labels: made.labels.filter((l) => !t.dropLabels.includes(l)).map((name) => ({ name })) });
      if (!pre) return res('', 1);
      return j({ state: pre.state, title: pre.title, url: `${URL_BASE}/${n}`, labels: pre.labels.map((name) => ({ name })) });
    }
    if (a === 'issue' && b === 'list' && args.includes('--search')) {
      const items = t.searchCap ? Array.from({ length: 1000 }, (_, i) => ({ number: 9000 + i, url: `${URL_BASE}/${9000 + i}`, body: 'x' })) : t.open.map((o) => ({ number: o.number, url: `${URL_BASE}/${o.number}`, body: o.body }));
      return j(items);
    }
    if (a === 'issue' && b === 'list') return t.dashFail ? res('', 1) : res('[]');
    if (/^api --paginate repos\/o\/r\/issues\?state=open/.test(line)) {
      return res(t.open.map((o) => JSON.stringify({ number: o.number, html_url: `${URL_BASE}/${o.number}`, body: o.body, pr: !!o.pr })).join('\n') + '\n');
    }
    m = /^api --paginate repos\/o\/r\/issues\/(\d+)\/events/.exec(line);
    if (m) {
      const read = t.eventReads++;
      if (t.eventsFail) return res('', 1);
      const made = t.created.find((c) => c.number === Number(m[1]));
      if (read < t.eventsLag) return res('');
      if (read < t.eventsLag + t.eventsPartial) return res(JSON.stringify({ label: made.labels[0], actor: t.labeller }) + '\n');
      const late = t.lateLabeller || t.labeller;
      return res(made.labels.map((l, i) => JSON.stringify({ label: l, actor: i === 0 ? t.labeller : late })).join('\n') + '\n');
    }
    if (a === 'issue' && b === 'create') {
      const n = t.next++;
      const labels = args[args.indexOf('--label') + 1].split(',');
      t.created.push({ number: n, title: args[args.indexOf('--title') + 1], labels, body: input });
      t.inputs.push(input);
      return res(`${URL_BASE}/${n}\n`);
    }
    m = /^api repos\/o\/r\/issues\/(\d+) --jq \.id/.exec(line);
    if (m) return res(String(9000 + Number(m[1])) + '\n');
    m = /^api --method POST repos\/o\/r\/issues\/(\d+)\/sub_issues/.exec(line);
    if (m) {
      if (t.edgeFail > 0) { t.edgeFail--; return res('', 1); }
      t.edges.push({ map: Number(m[1]), sub: line.split('sub_issue_id=')[1] });
      return res('{}');
    }
    return res('', 1);
  };
  return t;
}

function run(t, argv, extra = {}) {
  let out = '';
  let errOut = '';
  const code = main(argv, { gh: t.gh, guard: fakeGuard, env: {}, sleep: () => {}, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } }, ...extra });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json, errOut };
}

const base = (type, extra = []) => ['--type', type, '--title', 'Add login rate limit', '--body', 'Details here', '--repo', 'o/r', ...extra];
const creates = (t) => t.calls.filter((c) => c.startsWith('issue create'));

// The documented frontier filter, applied to the fake's created issues.
const onFrontier = (issue, destLabel) => issue.labels.includes('trailhead:ticket') && issue.labels.includes(destLabel)
  && !['trailhead:blocked', 'trailhead:unverified', 'trailhead:paused'].some((l) => issue.labels.includes(l));

// --- parseArgs ---------------------------------------------------------------------
{
  const o = parseArgs(base('bug', ['--map', '5', '--unverified', '--dedupe-key', 'a.b:c-1', '--no-dashboard']));
  ok('parseArgs: full bug', !o.error && o.type === 'bug' && o.map === 5 && o.unverified && o.dedupeKey === 'a.b:c-1' && o.noDashboard && o.repo === 'o/r' && o.body === 'Details here');
  ok('parseArgs: --unverified rejected for idea', /--unverified is only for ticket types/.test(parseArgs(base('idea', ['--unverified'])).error || ''));
  ok('parseArgs: seed with trigger', parseArgs(base('seed', ['--trigger', 'when X'])).trigger === 'when X');
  ok('parseArgs: --of with bug', parseArgs(base('bug', ['--of', '12'])).of === 12);
  ok('parseArgs: --body-file -', parseArgs(['--type', 'todo', '--title', 't', '--body-file', '-', '--repo', 'o/r']).bodyFile === '-');
}
for (const [name, argv] of [
  ['no args', []],
  ['unknown type', base('epic')],
  ['missing title', ['--type', 'bug', '--body', 'b', '--repo', 'o/r']],
  ['empty title', ['--type', 'bug', '--title', '  ', '--body', 'b', '--repo', 'o/r']],
  ['missing body', ['--type', 'bug', '--title', 't', '--repo', 'o/r']],
  ['body and body-file', base('bug', ['--body-file', 'x'])],
  ['missing repo', ['--type', 'bug', '--title', 't', '--body', 'b']],
  ['bad repo', ['--type', 'bug', '--title', 't', '--body', 'b', '--repo', 'nope']],
  ['seed without trigger', base('seed')],
  ['trigger on a todo', base('todo', ['--trigger', 'x'])],
  ['--of on a todo', base('todo', ['--of', '3'])],
  ['--of with --map', base('bug', ['--of', '3', '--map', '5'])],
  ['bad map', base('bug', ['--map', 'x'])],
  ['bad dedupe key (space)', base('bug', ['--dedupe-key', 'a b'])],
  ['bad dedupe key (too long)', base('bug', ['--dedupe-key', 'a'.repeat(101)])],
  ['unknown flag', base('bug', ['--bogus', '1'])],
  ['flag without value', ['--type']],
]) {
  ok(`parseArgs rejects: ${name}`, !!parseArgs(argv).error);
}

// --- buildIssue (pure) --------------------------------------------------------------
{
  const map = { number: 5, title: 'Map five', url: `${URL_BASE}/5` };
  const bug = buildIssue({ type: 'bug', title: 'T', body: 'B', map });
  ok('buildIssue bug on a map', bug.labels.join() === 'trailhead:ticket,trailhead:bug,trailhead:map-5' && bug.destination === 'map-5');
  ok('buildIssue map ticket: Parent is the first body line', bug.body.split('\n')[0] === `Parent: [Map five](${URL_BASE}/5)`);
  const todo = buildIssue({ type: 'todo', title: 'T', body: 'B', map: null });
  ok('buildIssue todo on the whiteboard', todo.labels.join() === 'trailhead:ticket,trailhead:build,trailhead:whiteboard' && todo.destination === 'whiteboard' && !/Parent:/.test(todo.body));
  const seed = buildIssue({ type: 'seed', title: 'T', body: 'B', map: null, trigger: 'when X ships' });
  ok('buildIssue seed labels', ['trailhead:ticket', 'trailhead:build', 'trailhead:seed', 'trailhead:blocked', 'trailhead:whiteboard'].every((l) => seed.labels.includes(l)));
  ok('buildIssue seed body: Trigger line and Blocked by section', /^Trigger: when X ships$/m.test(seed.body) && /## Blocked by\n[^]*when X ships/.test(seed.body));
  for (const [type, extra] of [['bug', {}], ['todo', {}], ['seed', { trigger: 'x' }]]) {
    const b = buildIssue({ type, title: 'T', body: 'B', map: null, unverified: true, ...extra });
    ok(`buildIssue ${type}: exactly one type label (state labels never count)`, b.labels.filter((l) => TYPE_LABELS.includes(l)).length === 1);
    ok(`buildIssue ${type}: --unverified adds the label`, b.labels.includes('trailhead:unverified'));
  }
  const idea = buildIssue({ type: 'idea', title: 'T', body: 'B', map: null });
  ok('buildIssue idea: only trailhead:fog, no Parent', idea.labels.join() === 'trailhead:fog' && !/Parent:/.test(idea.body));
  const ideaMap = buildIssue({ type: 'idea', title: 'T', body: 'B', map });
  ok('buildIssue idea with a map: Parent line, still only fog', ideaMap.labels.join() === 'trailhead:fog' && ideaMap.body.startsWith(`Parent: [Map five](${URL_BASE}/5)`));
  const reg = buildIssue({ type: 'bug', title: 'T', body: 'B', map: null, of: { title: 'Old work', url: `${URL_BASE}/9` } });
  ok('buildIssue --of: Regression of line', reg.body.includes(`Regression of: [Old work](${URL_BASE}/9)`));
  const dd = buildIssue({ type: 'todo', title: 'T', body: 'B', map: null, dedupeKey: 'k1' });
  ok('buildIssue dedupe marker', dd.body.includes('<!-- trailhead-dedupe: k1 -->'));
}

// --- allowlist parity with the guard Action ------------------------------------------
{
  const yml = fs.readFileSync(guardYml, 'utf8');
  const m = /const extra = (\(process\.env\.ALLOWLIST[^;]*?\.filter\(Boolean\));/.exec(yml);
  ok('parity: the guard parsing expression is found', !!m);
  const actionParse = (s) => new Function('process', `return ${m[1]};`)({ env: { ALLOWLIST: s } });
  for (const s of ['', 'a,b', ' A , b ,, C', ',,', 'Mixed,CASE ,  spaced  ', undefined]) {
    assert.deepStrictEqual(parseAllowlist(s), actionParse(s));
    passed++;
  }
}

// --- checkTrust -----------------------------------------------------------------------
{
  const t = makeTracker({ login: 'maint', perms: { maint: 'write' } });
  ok('checkTrust: write -> ok', checkTrust(t.gh, 'o/r').trust === 'ok');
  const tm = makeTracker({ login: 'm', perms: { m: 'maintain' } });
  ok('checkTrust: maintain -> ok', checkTrust(tm.gh, 'o/r').trust === 'ok');
  const ta = makeTracker({ login: 'bot', perms: {}, allowlist: 'Other, BOT' });
  ok('checkTrust: repo allowlist (case-insensitive) -> allowlisted', checkTrust(ta.gh, 'o/r').trust === 'allowlisted');
  const tn = makeTracker({ login: 'rando', perms: { rando: 'read' }, allowlist: 'someone' });
  ok('checkTrust: neither -> insufficient', checkTrust(tn.gh, 'o/r').trust === 'insufficient');
  const tu = makeTracker({ login: 'rando', perms: {}, allowlist: undefined });
  ok('checkTrust: unreadable variable counts as not allowlisted', checkTrust(tu.gh, 'o/r').trust === 'insufficient');
  const tp = makeTracker({ login: 'maint', permFail: true });
  ok('checkTrust: failed permission read counts as none', checkTrust(tp.gh, 'o/r').trust === 'insufficient');
  const ti = makeTracker({ login: null });
  ok('checkTrust: unreadable identity -> pending', checkTrust(ti.gh, 'o/r').trust === 'pending');
  const te = makeTracker({ login: 'rando', perms: {}, allowlist: undefined });
  const r = checkTrust(te.gh, 'o/r', { TRAILHEAD_LABEL_ALLOWLIST: 'rando' });
  ok('checkTrust: the local environment is never consulted', r.trust === 'insufficient');
}

// --- resolveDestination -----------------------------------------------------------------
{
  const t = makeTracker({ issues: {
    5: { state: 'OPEN', title: 'Map five', labels: ['trailhead:map'] },
    6: { state: 'CLOSED', title: 'Map six', labels: ['trailhead:map'] },
    7: { state: 'OPEN', title: 'Not a map', labels: ['trailhead:ticket'] },
    10: { state: 'CLOSED', title: 'Origin on 5', labels: ['trailhead:ticket', 'trailhead:map-5'] },
    11: { state: 'CLOSED', title: 'Origin loose', labels: ['trailhead:ticket', 'trailhead:whiteboard'] },
    12: { state: 'CLOSED', title: 'Origin on closed', labels: ['trailhead:ticket', 'trailhead:map-6'] },
    13: { state: 'CLOSED', title: 'Origin bare', labels: ['trailhead:ticket'] },
    14: { state: 'CLOSED', title: 'Origin both', labels: ['trailhead:ticket', 'trailhead:whiteboard', 'trailhead:map-5'] },
    15: { state: 'CLOSED', title: 'Origin two maps', labels: ['trailhead:ticket', 'trailhead:map-5', 'trailhead:map-6'] },
  } });
  const rd = (o) => resolveDestination(t.gh, 'o/r', o);
  ok('resolveDestination: open map', rd({ map: 5 }).map.number === 5 && rd({ map: 5 }).map.title === 'Map five');
  ok('resolveDestination: closed map is an error', !!rd({ map: 6 }).error);
  ok('resolveDestination: non-map issue is an error', !!rd({ map: 7 }).error);
  ok('resolveDestination: missing map is an error', !!rd({ map: 99 }).error);
  ok('resolveDestination: none -> whiteboard', rd({}).map === null && !rd({}).error);
  const of10 = rd({ of: 10 });
  ok('resolveDestination --of: inherits the open map and returns the origin', of10.map.number === 5 && of10.of.title === 'Origin on 5');
  const of11 = rd({ of: 11 });
  ok('resolveDestination --of: inherits the whiteboard', of11.map === null && !of11.error && of11.of.title === 'Origin loose');
  for (const n of [12, 13, 14, 15, 99]) {
    ok(`resolveDestination --of ${n}: unresolved`, /origin destination unresolved/.test(rd({ of: n }).error || ''));
  }
}

// --- findDuplicate ----------------------------------------------------------------------
{
  const t = makeTracker({ open: [{ number: 3, body: 'x\n<!-- trailhead-dedupe: k1 -->' }, { number: 4, body: 'mentions trailhead-dedupe: k1 only in prose' }] });
  const hit = findDuplicate(t.gh, 'o/r', 'k1');
  ok('findDuplicate: exact marker hit', hit.issue === 3 && hit.url.endsWith('/3'));
  ok('findDuplicate: prose mention is not a hit', findDuplicate(t.gh, 'o/r', 'k2') === null);
  ok('findDuplicate: search uses the quoted phrase and the cap', t.calls[0].includes('"trailhead-dedupe: k1" in:body') && t.calls[0].includes('--limit 1000'));
  const tc = makeTracker({ searchCap: true, open: [{ number: 40, body: 'a <!-- trailhead-dedupe: k9 --> b' }, { number: 41, body: 'pr', pr: true }] });
  const capHit = findDuplicate(tc.gh, 'o/r', 'k9');
  ok('findDuplicate: a capped search falls back to the full paginated scan', capHit && capHit.issue === 40 && tc.calls.some((c) => c.startsWith('api --paginate repos/o/r/issues?state=open')));
  const tf = makeTracker({ searchCap: true, open: [{ number: 41, body: '<!-- trailhead-dedupe: k9 -->', pr: true }] });
  ok('findDuplicate: pull requests are skipped in the scan', findDuplicate(tf.gh, 'o/r', 'k9') === null);
}

// --- main: type x destination ---------------------------------------------------------
for (const type of ['bug', 'todo', 'seed']) {
  const extra = type === 'seed' ? ['--trigger', 'when X ships'] : [];
  const tm = makeTracker();
  const rm = run(tm, base(type, ['--map', '5', ...extra]));
  const made = tm.created[0];
  ok(`${type} on a map: created, exit 0, one JSON line`, rm.code === 0 && rm.json.status === 'created' && rm.out.trim().split('\n').length === 1);
  ok(`${type} on a map: output fields`, rm.json.issue === 100 && rm.json.url.endsWith('/100') && rm.json.type === type && rm.json.destination === 'map-5' && rm.json.trust === 'ok' && rm.json.edge === 'ok' && rm.json.dashboard === 'not-applicable' && Array.isArray(rm.json.warnings));
  ok(`${type} on a map: labels ride in the single create call`, creates(tm).length === 1 && made.labels.includes('trailhead:map-5') && made.labels.includes('trailhead:ticket'));
  ok(`${type} on a map: Parent first line, body on stdin`, made.body.split('\n')[0] === `Parent: [Map five](${URL_BASE}/5)` && tm.calls[tm.calls.findIndex((c) => c.startsWith('issue create'))].includes('--body-file -'));
  ok(`${type} on a map: native edge`, tm.edges.length === 1 && tm.edges[0].map === 5 && tm.edges[0].sub === '9100');
  ok(`${type} on a map: no dashboard call`, !tm.calls.some((c) => c.includes('trailhead:dashboard')));
  const onF = onFrontier(made, 'trailhead:map-5');
  ok(`${type} on a map: frontier membership`, type === 'seed' ? (made.labels.includes('trailhead:map-5') && !onF) : onF);

  const tw = makeTracker();
  const dashCalls = [];
  const rw = run(tw, base(type, extra), { dashboard: { main: (argv) => { dashCalls.push(argv); return 0; } } });
  const madeW = tw.created[0];
  ok(`${type} on the whiteboard: created, whiteboard label, no Parent, no edge`, rw.json.status === 'created' && rw.json.destination === 'whiteboard' && madeW.labels.includes('trailhead:whiteboard') && !/Parent:/.test(madeW.body) && tw.edges.length === 0 && !('edge' in rw.json));
  ok(`${type} on the whiteboard: label ensured before create`, tw.calls.findIndex((c) => c.startsWith('label create trailhead:whiteboard')) >= 0 && tw.calls.findIndex((c) => c.startsWith('label create trailhead:whiteboard')) < tw.calls.findIndex((c) => c.startsWith('issue create')));
  ok(`${type} on the whiteboard: dashboard refreshed update-only`, rw.json.dashboard === 'refreshed' && dashCalls.length === 1 && dashCalls[0].join(' ') === '--repo o/r --update-only');
  const onW = onFrontier(madeW, 'trailhead:whiteboard');
  ok(`${type} on the whiteboard: frontier membership`, type === 'seed' ? (madeW.labels.includes('trailhead:whiteboard') && !onW) : onW);
}
{
  const t = makeTracker();
  const r = run(t, base('todo', ['--unverified']));
  ok('--unverified is held off the frontier', t.created[0].labels.includes('trailhead:unverified') && !onFrontier(t.created[0], 'trailhead:whiteboard') && r.json.status === 'created');
}
{
  // The real dashboard helper in-process through the fake tracker: no dashboard issue -> skipped, exit 0.
  const t = makeTracker();
  const r = run(t, base('bug'));
  ok('whiteboard capture runs the real dashboard helper update-only', r.json.dashboard === 'refreshed' && t.calls.some((c) => c.includes('--label trailhead:dashboard')) && !t.calls.some((c) => c.startsWith('issue create') && c.includes('trailhead:dashboard')));
  const tn = makeTracker();
  ok('--no-dashboard skips the refresh', run(tn, base('bug', ['--no-dashboard'])).json.dashboard === 'skipped' && !tn.calls.some((c) => c.includes('--label trailhead:dashboard')));
  const tf = makeTracker({ dashFail: true });
  const rf = run(tf, base('bug'));
  ok('dashboard failure keeps the status, flags it, warns', rf.code === 0 && rf.json.status === 'created' && rf.json.dashboard === 'failed' && rf.json.warnings.length === 1);
}

// --- main: idea as fog -----------------------------------------------------------------
{
  const t = makeTracker();
  const r = run(t, base('idea'));
  ok('idea: created as trailhead:fog only', r.code === 0 && r.json.status === 'created' && t.created[0].labels.join() === 'trailhead:fog' && r.json.labels.join() === 'trailhead:fog');
  ok('idea: no edge, no dashboard, no map label', t.edges.length === 0 && r.json.dashboard === 'not-applicable' && !t.calls.some((c) => c.includes('trailhead:dashboard')) && !('edge' in r.json));
  const tm = makeTracker();
  const rm = run(tm, base('idea', ['--map', '5']));
  ok('idea with a map: Parent line, still fog only, no edge', rm.json.status === 'created' && tm.created[0].body.startsWith('Parent: [Map five]') && tm.created[0].labels.join() === 'trailhead:fog' && tm.edges.length === 0 && rm.json.destination === 'map-5');
  const tc = makeTracker();
  ok('idea with a closed map is rejected, nothing created', run(tc, base('idea', ['--map', '6'])).code === 1 && creates(tc).length === 0);
}

// --- main: trust --------------------------------------------------------------------------
{
  const t = makeTracker({ login: 'rando', perms: { rando: 'read' }, allowlist: 'x' });
  const r = run(t, base('bug', ['--map', '5']));
  ok('insufficient trust: exit 1, trust insufficient, no create call', r.code === 1 && r.json.status === 'error' && r.json.trust === 'insufficient' && creates(t).length === 0);
  const ta = makeTracker({ login: 'bot', perms: {}, allowlist: 'bot' });
  ok('allowlisted identity: created with trust allowlisted', run(ta, base('todo')).json.trust === 'allowlisted');
}
{
  // Unreadable identity: decided from the labeled events after create.
  const cases = [
    ['github-actions[bot]', {}, 'actions-token', 0],
    ['appbot', { allowlist: 'AppBot' }, 'allowlisted', 0],
    ['writer', { perms: { writer: 'write' } }, 'ok', 0],
    ['stranger', { perms: { stranger: 'read' }, allowlist: 'x' }, null, 1],
  ];
  for (const [labeller, extra, trust, code] of cases) {
    const t = makeTracker({ login: null, labeller, ...extra });
    const r = run(t, base('bug', ['--map', '5']));
    if (code === 0) {
      ok(`pending trust, labelled by ${labeller}: created as ${trust}`, r.code === 0 && r.json.status === 'created' && r.json.trust === trust && t.edges.length === 1);
    } else {
      ok(`pending trust, labelled by ${labeller}: error, no edge`, r.code === 1 && r.json.status === 'error' && r.json.trust === 'insufficient' && r.json.issue === 100 && /will be stripped/.test(r.json.reason) && t.edges.length === 0);
    }
  }
  const te = makeTracker({ login: null, eventsFail: true });
  const re = run(te, base('bug', ['--map', '5']));
  ok('pending trust, events unreadable: error, no edge', re.code === 1 && re.json.trust === 'insufficient' && re.json.issue === 100 && /could not be read/.test(re.json.reason) && !/stripped/.test(re.json.reason) && te.edges.length === 0);
  ok('events unreadable: retried on the backoff schedule', te.eventReads === 4);
  const naps = [];
  const tl = makeTracker({ login: null, labeller: 'github-actions[bot]', eventsLag: 2 });
  const rl = run(tl, base('bug', ['--map', '5']), { sleep: (ms) => naps.push(ms) });
  ok('pending trust, events empty at first: created as actions-token after naps', rl.code === 0 && rl.json.status === 'created' && rl.json.trust === 'actions-token' && tl.edges.length === 1 && naps.slice(0, 2).join() === '1000,2000');
  const tp = makeTracker({ login: null, labeller: 'github-actions[bot]', eventsPartial: 2 });
  const rp = run(tp, base('bug', ['--map', '5']));
  ok('pending trust, partial events: created only once every label is visible', rp.code === 0 && rp.json.trust === 'actions-token' && tp.eventReads === 3);
  const tn = makeTracker({ login: null, labeller: 'github-actions[bot]', eventsLag: 99 });
  const rn = run(tn, base('bug', ['--map', '5']));
  ok('pending trust, labels never visible: distinct reason naming labels, issue kept, no edge', rn.code === 1 && rn.json.trust === 'insufficient' && rn.json.issue === 100 && /no visible labeled event/.test(rn.json.reason) && /trailhead:bug/.test(rn.json.reason) && !/stripped/.test(rn.json.reason) && tn.edges.length === 0 && tn.eventReads === 4);
  const tb = makeTracker({ login: null, labeller: 'stranger', perms: { stranger: 'read' }, allowlist: 'x' });
  const rb = run(tb, base('bug', ['--map', '5']));
  ok('bad actor fails at once, without retries', rb.code === 1 && rb.json.trust === 'insufficient' && /stranger will be stripped/.test(rb.json.reason) && tb.edges.length === 0 && tb.eventReads === 1);
  const tlb = makeTracker({ login: null, labeller: 'github-actions[bot]', lateLabeller: 'stranger', perms: { stranger: 'read' }, allowlist: 'x', eventsPartial: 1 });
  const rlb = run(tlb, base('bug', ['--map', '5']));
  ok('bad actor on a later read fails, though an earlier read was trusted', rlb.code === 1 && rlb.json.trust === 'insufficient' && /stranger will be stripped/.test(rlb.json.reason) && tlb.edges.length === 0 && tlb.eventReads === 2);
  const empty = cap.verifyActors(() => ({ status: 0, stdout: '', stderr: '' }), 'o/r', 100, [], () => {});
  ok('no expected trailhead:* label: fails closed, never trusts an empty events list', !empty.trust && /no trailhead:\* label to verify/.test(empty.error));
}

// --- main: read-back, dedupe, edge, --of, secrets ------------------------------------------
{
  const t = makeTracker({ dropLabels: ['trailhead:map-5'] });
  const r = run(t, base('bug', ['--map', '5']));
  ok('labels missing at read-back: exit 1, issue named, no edge', r.code === 1 && r.json.status === 'error' && /labels missing/.test(r.json.reason) && r.json.issue === 100 && t.edges.length === 0);
}
{
  const t = makeTracker({ open: [{ number: 3, body: '<!-- trailhead-dedupe: nightly-1 -->' }] });
  const r = run(t, base('bug', ['--dedupe-key', 'nightly-1']));
  ok('dedupe hit: existing, exit 0, no create call', r.code === 0 && r.json.status === 'existing' && r.json.issue === 3 && r.json.dedupeKey === 'nightly-1' && creates(t).length === 0);
  const r2 = run(t, base('bug', ['--dedupe-key', 'nightly-2']));
  ok('dedupe miss: created, marker in the body', r2.json.status === 'created' && t.created[0].body.includes('<!-- trailhead-dedupe: nightly-2 -->'));
}
{
  const t1 = makeTracker({ edgeFail: 1 });
  const r1 = run(t1, base('bug', ['--map', '5']));
  ok('edge fails once then succeeds: created', r1.code === 0 && r1.json.status === 'created' && r1.json.edge === 'ok' && t1.edges.length === 1);
  const t2 = makeTracker({ edgeFail: 2 });
  const r2 = run(t2, base('bug', ['--map', '5']));
  ok('edge fails twice: partial, exit 3, names prune', r2.code === 3 && r2.json.status === 'partial' && r2.json.edge === 'failed' && r2.json.issue === 100 && r2.json.warnings.some((w) => /trailhead prune command/.test(w)) && t2.edges.length === 0);
}
{
  const t = makeTracker({ issues: { 5: { state: 'OPEN', title: 'Map five', labels: ['trailhead:map'] }, 10: { state: 'CLOSED', title: 'Origin on 5', labels: ['trailhead:map-5'] }, 12: { state: 'CLOSED', title: 'Origin closed map', labels: ['trailhead:map-6'] }, 6: { state: 'CLOSED', title: 'm6', labels: ['trailhead:map'] } } });
  const r = run(t, base('bug', ['--of', '10']));
  ok('--of inherits the map: label, Parent, Regression of, edge', r.json.destination === 'map-5' && t.created[0].labels.includes('trailhead:map-5') && t.created[0].body.includes('Regression of: [Origin on 5]') && t.edges.length === 1);
  const tu = makeTracker({ issues: { 12: { state: 'CLOSED', title: 'x', labels: ['trailhead:map-6'] }, 6: { state: 'CLOSED', title: 'm6', labels: ['trailhead:map'] } } });
  const ru = run(tu, base('bug', ['--of', '12']));
  ok('--of unresolved: exit 1, nothing created', ru.code === 1 && /origin destination unresolved/.test(ru.json.reason) && creates(tu).length === 0);
}
{
  const t = makeTracker();
  const r = run(t, ['--type', 'todo', '--title', 'T', '--body', 'token ghp_abcdefghijklmnopqrstuvwxyz0123', '--repo', 'o/r']);
  ok('secret in the body: exit 1, no create', r.code === 1 && /secret/.test(r.json.reason) && creates(t).length === 0);
  const ts = makeTracker();
  ok('secret in the title: exit 1, no create', run(ts, ['--type', 'todo', '--title', 'ghp_abcdefghijklmnopqrstuvwxyz0123', '--body', 'b', '--repo', 'o/r']).code === 1 && creates(ts).length === 0);
  const tmx = makeTracker({ issues: { 5: { state: 'OPEN', title: 'Map ghp_abcdefghijklmnopqrstuvwxyz0123', labels: ['trailhead:map'] } } });
  ok('secret in a map title (Parent line): exit 1, no create', run(tmx, base('bug', ['--map', '5'])).code === 1 && creates(tmx).length === 0);
  const tg = makeTracker();
  const rg = run(tg, base('bug'), { guard: null });
  ok('guard missing fails closed', rg.code === 1 && rg.json.status === 'error' && creates(tg).length === 0);
  const tb = makeTracker();
  ok('closed map: exit 1, no create', run(tb, base('bug', ['--map', '6'])).code === 1 && creates(tb).length === 0);
  const tbf = makeTracker({ login: 'x', perms: { x: 'admin' } });
  const rf = run(tbf, ['--type', 'todo', '--title', 'T', '--body-file', '-', '--repo', 'o/r'], { stdin: 'body from stdin' });
  ok('--body-file - reads stdin', rf.json.status === 'created' && tbf.created[0].body.includes('body from stdin'));
}

// --- usage ----------------------------------------------------------------------------------
for (const argv of [[], ['--type', 'epic'], base('seed'), base('todo', ['--of', '3'])]) {
  const t = makeTracker();
  const r = run(t, argv);
  ok(`usage error exit 2 with a usage JSON line: ${argv.join(' ')}`, r.code === 2 && r.json.status === 'usage' && r.json.reason.length > 0 && r.errOut.length > 0 && t.calls.length === 0);
}

// --- end-to-end with a fake gh on PATH ---------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const log = path.join(tmp, 'calls.log');
  const script = `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "api user"*) echo maint ;;
  "api repos/o/r/collaborators/maint/permission"*) echo '{"permission":"admin","role_name":"admin"}' ;;
  "issue view 5 "*) echo '{"state":"OPEN","title":"Map five","url":"https://github.com/o/r/issues/5","labels":[{"name":"trailhead:map"}]}' ;;
  "issue view 100 "*) echo '{"labels":[{"name":"trailhead:ticket"},{"name":"trailhead:bug"},{"name":"trailhead:map-5"}]}' ;;
  "issue create"*) cat > "${path.join(tmp, 'body.txt')}"; echo https://github.com/o/r/issues/100 ;;
  "api repos/o/r/issues/100 --jq .id") echo 9100 ;;
  *) exit 0 ;;
esac
`;
  fs.writeFileSync(path.join(binDir, 'gh'), script, { mode: 0o755 });
  const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
  const res = spawnSync('node', [scriptPath, ...base('bug', ['--map', '5'])], { encoding: 'utf8', env });
  const j = JSON.parse(res.stdout.trim());
  ok('e2e: prints one created JSON line, exit 0', res.status === 0 && j.status === 'created' && j.issue === 100 && j.edge === 'ok');
  const calls = fs.readFileSync(log, 'utf8');
  ok('e2e: create before read-back before edge', calls.indexOf('issue create') < calls.indexOf('issue view 100') && calls.indexOf('issue view 100') < calls.indexOf('sub_issues'));
  ok('e2e: body reached gh on stdin with the Parent line', fs.readFileSync(path.join(tmp, 'body.txt'), 'utf8').startsWith('Parent: [Map five]'));
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const bad = spawnSync('node', [scriptPath, ...base('bug', ['--map', '5'])], { encoding: 'utf8', env });
  ok('e2e: gh failing exits 1 with an error line', bad.status === 1 && JSON.parse(bad.stdout.trim()).status === 'error');
  ok('e2e: usage error exits 2', spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' }).status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`capture.test.js: ${passed} checks passed`);
