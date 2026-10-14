#!/usr/bin/env node
// Tests for templates/trailhead-dashboard.js. Run: node dashboard.test.js
// No framework: plain asserts, same style as issue-body.test.js.
//
// Layers covered:
//   1. Pure renderDashboard() / mapFlags() on a fixed snapshot.
//   2. main() against a fake tracker behind an injected `gh` runner: what is
//      gathered (and what is not), last-audit carry-through, self-heal
//      (create + pin, re-pin), the guarded write, dry-run.
//   3. End-to-end: the script itself with a failing fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-dashboard.js');
const { renderDashboard, mapFlags, main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const AUDIT = '<!-- trailhead:last-audit 2026-10-01T10:00:00Z -->';

// --- pure render -------------------------------------------------------------
const SNAP = {
  repo: 'o/r',
  maps: [
    { number: 14, title: '🗺 multi-host', openScoped: 0, total: 20, fog: false, closedEdges: null },
    { number: 98, title: '🗺 website [v1]', openScoped: 5, total: 92, fog: null, closedEdges: true },
    { number: 5, title: '🗺 plain', openScoped: 3, total: 10, fog: null, closedEdges: null },
  ],
  whiteboard: [
    { number: 30, title: 'Frontier one', assignees: [], labels: ['trailhead:ticket', 'trailhead:whiteboard', 'trailhead:build'] },
    { number: 31, title: 'Doing it', assignees: ['me'], labels: ['trailhead:ticket', 'trailhead:whiteboard'] },
    { number: 32, title: 'Stuck', assignees: [], labels: ['trailhead:ticket', 'trailhead:whiteboard', 'trailhead:blocked'] },
  ],
  resolved: [{ number: 20, title: 'Done a' }, { number: 19, title: 'Done b' }],
  inbox: 4,
  anchors: { codebase: 2, conventions: 3 },
  lastAudit: AUDIT,
};

{
  const body = renderDashboard(SNAP);
  ok('render: deterministic', body === renderDashboard(JSON.parse(JSON.stringify(SNAP))));
  ok('render: ends with a single newline', body.endsWith('\n') && !body.endsWith('\n\n'));
  const heads = body.split('\n').filter((l) => l.startsWith('## '));
  ok('render: the three sections in order', JSON.stringify(heads) === JSON.stringify(['## 🗺 Maps', '## 🧷 Whiteboard (map-less tickets)', '## 📊 Counts']));
  ok('render: map link with open count', body.includes('- [🗺 multi-host](https://github.com/o/r/issues/14): 0 open'));
  ok('render: bracket in a title is escaped', body.includes('[🗺 website \\[v1\\]](https://github.com/o/r/issues/98)'));
  ok('render: exhausted flag', /issues\/14\): 0 open · exhausted · closeable/.test(body));
  ok('render: near cap + prunable flag', /issues\/98\): 5 open · near cap · 92\/100 · prunable/.test(body));
  ok('render: an unflagged map has no flag', /issues\/5\): 3 open\n/.test(body));
  ok('render: whiteboard lists', /Frontier \(1\):\n- \[Frontier one #30\]\(https:\/\/github.com\/o\/r\/issues\/30\)/.test(body)
    && /In progress \(1\):\n- \[Doing it #31\]/.test(body) && /Blocked \(1\):\n- \[Stuck #32\]/.test(body));
  ok('render: recently resolved titles', body.includes('_Recently resolved: [Done a #20](https://github.com/o/r/issues/20), [Done b #19](https://github.com/o/r/issues/19)_'));
  ok('render: counts', /- Untriaged inbox: 4/.test(body) && /- Whiteboard frontier: 1/.test(body) && /- Open maps: 3/.test(body));
  ok('render: anchors line', body.includes('[Codebase #2](https://github.com/o/r/issues/2)') && body.includes('[Conventions #3](https://github.com/o/r/issues/3)'));
  ok('render: last-audit marker verbatim and last', body.trimEnd().endsWith(AUDIT));
  ok('render: no em-dash', !body.includes('—'));
}
{
  const body = renderDashboard({ ...SNAP, lastAudit: null, maps: [], whiteboard: [], resolved: [], anchors: { codebase: null, conventions: null } });
  ok('render: empty tracker still has every section', /_No open maps\._/.test(body) && /_Nothing on the whiteboard\._/.test(body));
  ok('render: no marker when none exists', !body.includes('last-audit'));
  ok('render: no anchors line when none exist', !body.includes('Anchors'));
}
{
  ok('mapFlags: exhausted needs zero scoped and no fog', JSON.stringify(mapFlags({ openScoped: 0, total: 3, fog: false })) === JSON.stringify(['exhausted · closeable']));
  ok('mapFlags: fog keeps a zero-count map unflagged', mapFlags({ openScoped: 0, total: 3, fog: true }).length === 0);
  ok('mapFlags: at cap', JSON.stringify(mapFlags({ openScoped: 4, total: 100, closedEdges: false })) === JSON.stringify(['at cap · 100/100']));
  ok('mapFlags: at cap prunable', JSON.stringify(mapFlags({ openScoped: 4, total: 100, closedEdges: true })) === JSON.stringify(['at cap · 100/100 · prunable']));
  ok('mapFlags: 89 is not near cap', mapFlags({ openScoped: 4, total: 89 }).length === 0);
}

// --- fake tracker ------------------------------------------------------------
function makeTracker(init = {}) {
  const t = {
    maps: init.maps || [
      { number: 14, title: '🗺 multi-host', scoped: 0, total: 20, body: '## Destination\nx\n\n## Not yet specified\n_none yet_\n', edges: [] },
      { number: 98, title: '🗺 website', scoped: 5, total: 92, body: 'body of 98 long enough', edges: [{ number: 1, state: 'closed' }, { number: 2, state: 'open' }] },
      { number: 5, title: '🗺 plain', scoped: 3, total: 10, body: 'body of 5 long enough text', edges: [] },
    ],
    whiteboardOpen: init.whiteboardOpen || [
      { number: 30, title: 'Frontier one', labels: [{ name: 'trailhead:ticket' }, { name: 'trailhead:whiteboard' }], assignees: [] },
      { number: 31, title: 'Doing it', labels: [{ name: 'trailhead:ticket' }, { name: 'trailhead:whiteboard' }], assignees: [{ login: 'me' }] },
    ],
    closed: init.closed || [
      { number: 20, title: 'Done a', closedAt: '2026-10-10T00:00:00Z', labels: [{ name: 'trailhead:whiteboard' }] },
      { number: 19, title: 'Done old', closedAt: '2026-10-01T00:00:00Z', labels: [{ name: 'trailhead:whiteboard' }] },
      { number: 18, title: 'Out of scope one', closedAt: '2026-10-12T00:00:00Z', labels: [{ name: 'trailhead:whiteboard' }, { name: 'trailhead:out-of-scope' }] },
    ],
    openIssues: init.openIssues || [
      { number: 50, labels: [] }, { number: 51, labels: [{ name: 'bug' }] }, { number: 52, labels: [{ name: 'trailhead:ticket' }] },
    ],
    codebase: init.codebase === undefined ? 2 : init.codebase,
    conventions: init.conventions === undefined ? 3 : init.conventions,
    dash: init.dash === undefined ? { number: 33, body: 'Old hand written dashboard body.\n\n## Maps\nlots of prose here\n' + AUDIT + '\n', updatedAt: 'T1' } : init.dash,
    pinned: init.pinned || [33],
    edits: 1,
    labels: [],
    calls: [],
    writes: [],
    created: [],
    pins: [],
    failOn: init.failOn || null,
  };
  const ok_ = (stdout) => ({ status: 0, stdout, stderr: '' });
  t.gh = (args) => {
    const line = args.join(' ');
    t.calls.push(line);
    if (t.failOn && t.failOn.test(line)) return { status: 1, stdout: '', stderr: 'forced failure' };
    if (args[0] === 'repo' && args[1] === 'view') return ok_('o/r\n');
    if (args[0] === 'label' && args[1] === 'create') { t.labels.push(args[2]); return ok_(''); }
    if (args[0] === 'issue' && args[1] === 'list') {
      const li = args.indexOf('--label');
      const label = li < 0 ? undefined : args[li + 1];
      const state = args[args.indexOf('--state') + 1];
      if (label === 'trailhead:map') return ok_(JSON.stringify(t.maps.map((m) => ({ number: m.number, title: m.title }))));
      if (/^trailhead:map-\d+$/.test(label || '')) {
        const m = t.maps.find((x) => 'trailhead:map-' + x.number === label);
        return ok_(JSON.stringify(Array.from({ length: m.scoped }, (_, i) => ({ number: 1000 + i }))));
      }
      if (label === 'trailhead:whiteboard' && state === 'open') return ok_(JSON.stringify(t.whiteboardOpen));
      if (label === 'trailhead:whiteboard' && state === 'closed') return ok_(JSON.stringify(t.closed));
      if (label === 'trailhead:codebase') return ok_(JSON.stringify(t.codebase ? [{ number: t.codebase }] : []));
      if (label === 'trailhead:conventions') return ok_(JSON.stringify(t.conventions ? [{ number: t.conventions }] : []));
      if (label === 'trailhead:dashboard') return ok_(JSON.stringify(t.dash ? [{ number: t.dash.number }] : []));
      if (label === undefined) return ok_(JSON.stringify(t.openIssues));
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      const n = Number(args[2]);
      if (t.dash && n === t.dash.number) return ok_(JSON.stringify({ body: t.dash.body, updatedAt: t.dash.updatedAt }));
      const m = t.maps.find((x) => x.number === n);
      if (m) return ok_(JSON.stringify({ body: m.body, updatedAt: 'M' }));
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const text = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      t.writes.push(text);
      t.dash.body = text;
      t.edits += 1;
      t.dash.updatedAt = 'T2';
      return ok_('');
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const text = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      t.created.push({ text, args });
      t.dash = { number: 77, body: text, updatedAt: 'T1' };
      return ok_('https://github.com/o/r/issues/77\n');
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const q = args.find((a) => a.startsWith('query=')) || '';
      if (/userContentEdits/.test(q)) return ok_(JSON.stringify({ data: { repository: { issue: { userContentEdits: { totalCount: t.edits } } } } }));
      if (/pinnedIssues/.test(q)) return ok_(JSON.stringify({ data: { repository: { pinnedIssues: { nodes: t.pinned.map((number) => ({ issue: { number } })) } } } }));
      if (/pinIssue/.test(q)) { t.pins.push(args.join(' ')); return ok_('{}'); }
    }
    if (args[0] === 'api') {
      const ep = args[1];
      let m = /^repos\/o\/r\/issues\/(\d+)\/sub_issues/.exec(ep);
      if (m) return ok_(JSON.stringify(t.maps.find((x) => x.number === Number(m[1])).edges));
      m = /^repos\/o\/r\/issues\/(\d+)$/.exec(ep);
      if (m) {
        const n = Number(m[1]);
        if (args.includes('.node_id')) return ok_('NODE_' + n + '\n');
        const mp = t.maps.find((x) => x.number === n);
        if (mp) return ok_(String(mp.total) + '\n');
      }
    }
    return { status: 1, stdout: '', stderr: 'unexpected: ' + line };
  };
  return t;
}

const fakeGuard = { scan: (text) => (/ghp_[A-Za-z0-9]{20,}/.test(text) ? 'github token' : null) };

function runMain(argv, t, extra = {}) {
  const chunks = [];
  const errChunks = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { gh: t.gh, stdout: { write: (s) => chunks.push(s) }, guard: fakeGuard, ...extra });
  } finally {
    process.stderr.write = realErr;
  }
  return { code, out: chunks.join(''), err: errChunks.join('') };
}

// --- regenerate an existing dashboard ----------------------------------------
{
  const t = makeTracker();
  const oldSize = Buffer.byteLength(t.dash.body);
  const r = runMain(['--repo', 'o/r'], t);
  ok('regen: exit 0', r.code === 0);
  ok('regen: exactly one output line', r.out.split('\n').filter(Boolean).length === 1);
  ok('regen: summary line', /^dashboard #33: 3 maps, whiteboard 2, flags: map-14 exhausted, map-98 near cap 92\/100 prunable/.test(r.out));
  ok('regen: reports old and new size', new RegExp(`body ${oldSize} -> ${Buffer.byteLength(t.writes[0])} bytes`).test(r.out));
  ok('regen: one write', t.writes.length === 1);
  ok('regen: the old prose is gone, the shape is generated', !t.writes[0].includes('lots of prose here') && t.writes[0].includes('## 🗺 Maps'));
  ok('regen: last-audit kept verbatim', t.writes[0].trimEnd().endsWith(AUDIT));
  ok('regen: closed out-of-scope tickets are not "resolved", newest first', /Recently resolved: \[Done a #20\].*\[Done old #19\]/.test(t.writes[0]) && !t.writes[0].includes('Out of scope one'));
  ok('regen: inbox counts only issues without a trailhead label', /- Untriaged inbox: 2/.test(t.writes[0]));
  ok('regen: label ensured first', t.labels.includes('trailhead:dashboard'));
  ok('regen: already pinned, no pin call', t.pins.length === 0);
}

// --- what is (not) gathered --------------------------------------------------
{
  const t = makeTracker();
  runMain(['--repo', 'o/r'], t);
  const views = t.calls.filter((c) => c.startsWith('issue view'));
  ok('fog: body read only for the zero-count map', views.some((c) => c.startsWith('issue view 14 ')) && !views.some((c) => c.startsWith('issue view 98 ') || c.startsWith('issue view 5 ')));
  const edges = t.calls.filter((c) => /\/sub_issues/.test(c));
  ok('closed-edge check only for near/at-cap maps', edges.length === 1 && /issues\/98\/sub_issues/.test(edges[0]));
}
{
  // a zero-count map with fog left is not exhausted
  const t = makeTracker({ maps: [{ number: 14, title: '🗺 m', scoped: 0, total: 2, body: '## Not yet specified\n- still foggy\n', edges: [] }] });
  const r = runMain(['--repo', 'o/r'], t);
  ok('fog left: not flagged exhausted', /flags: none/.test(r.out) && !t.writes[0].includes('exhausted'));
}

// --- W2: a missing fog section is unconfirmed, not empty ----------------------
{
  const t = makeTracker({ maps: [{ number: 14, title: '🗺 m', scoped: 0, total: 2, body: '## Destination\nSomewhere good, long enough.\n', edges: [] }] });
  const r = runMain(['--repo', 'o/r'], t);
  ok('W2: no "Not yet specified" section: not flagged exhausted', r.code === 0 && /flags: none/.test(r.out) && !t.writes[0].includes('exhausted'));
  ok('W2: mapFlags keeps fog=null unflagged', mapFlags({ openScoped: 0, total: 2, fog: null }).length === 0);
}

// --- W3: newest closures are inside the window; a hit limit is said out loud --
{
  const t = makeTracker();
  runMain(['--repo', 'o/r'], t);
  const q = t.calls.find((c) => c.startsWith('issue list --label trailhead:whiteboard --state closed'));
  ok('W3: the resolved query is sorted by recent updates', /--search sort:updated-desc/.test(q));
  ok('W3: a normal run reports no truncation', !/truncated/.test(t.writes[0]) && !/truncated/.test(runMain(['--repo', 'o/r', '--dry-run'], makeTracker()).out));
}
{
  const many = (n, extra) => Array.from({ length: n }, (_, i) => ({ number: 5000 + i, title: 't' + i, labels: [], assignees: [], ...extra }));
  const t = makeTracker({ openIssues: many(1000) });
  const r = runMain(['--repo', 'o/r'], t);
  ok('W3: inbox at its limit is said in the output line', r.code === 0 && /truncated: inbox/.test(r.out));
  ok('W3: the inbox count is rendered as a lower bound', /- Untriaged inbox: 1000\+/.test(t.writes[0]));
  const w = makeTracker({ whiteboardOpen: many(200, { labels: [{ name: 'trailhead:whiteboard' }] }) });
  ok('W3: whiteboard at its limit is said', /truncated: whiteboard/.test(runMain(['--repo', 'o/r'], w).out));
  const dropped = many(100, { closedAt: '2026-10-01T00:00:00Z', labels: [{ name: 'trailhead:whiteboard' }, { name: 'trailhead:out-of-scope' }] });
  const c = makeTracker({ closed: dropped });
  ok('W3: a full resolved window that filters down below 10 is said', /truncated: resolved/.test(runMain(['--repo', 'o/r'], c).out));
  const fine = many(100, { closedAt: '2026-10-01T00:00:00Z', labels: [{ name: 'trailhead:whiteboard' }] });
  ok('W3: a full resolved window with 10 to show is not truncation', !/truncated/.test(runMain(['--repo', 'o/r'], makeTracker({ closed: fine })).out));
  const both = runMain(['--repo', 'o/r'], makeTracker({ openIssues: many(1000), whiteboardOpen: many(200, { labels: [{ name: 'trailhead:whiteboard' }] }) }));
  ok('W3: several truncations listed on the one line', both.out.trim().split('\n').length === 1 && /truncated: whiteboard, inbox/.test(both.out));
}

// --- last audit --------------------------------------------------------------
{
  const t = makeTracker();
  const r = runMain(['--repo', 'o/r', '--set-last-audit', '2026-10-14T09:30:00Z'], t);
  ok('set-last-audit: replaces the marker', r.code === 0 && t.writes[0].includes('<!-- trailhead:last-audit 2026-10-14T09:30:00Z -->') && !t.writes[0].includes('2026-10-01'));
  ok('set-last-audit: exactly one marker', (t.writes[0].match(/trailhead:last-audit/g) || []).length === 1);
  const t2 = makeTracker({ dash: { number: 33, body: 'Old body with no marker at all, long enough.', updatedAt: 'T1' } });
  runMain(['--repo', 'o/r', '--set-last-audit', '2026-10-14T09:30:00Z'], t2);
  ok('set-last-audit: added when absent', t2.writes[0].trimEnd().endsWith('<!-- trailhead:last-audit 2026-10-14T09:30:00Z -->'));
  const bad = runMain(['--repo', 'o/r', '--set-last-audit', 'yesterday'], makeTracker());
  ok('set-last-audit: a non-ISO value is a usage error', bad.code === 2 && bad.err.length > 0 && bad.out === '');
}

// --- I1: a title cannot forge the last-audit marker ---------------------------
{
  const FORGED = '<!-- trailhead:last-audit 2000-01-01T00:00:00Z -->';
  const body = renderDashboard({
    ...SNAP,
    lastAudit: null,
    maps: [{ number: 1, title: 'evil ' + FORGED, openScoped: 1, total: 1, fog: null, closedEdges: null }],
    whiteboard: [{ number: 2, title: FORGED + ' wb', assignees: [], labels: [] }],
    resolved: [{ number: 3, title: 'x --> y <!-- z' }],
  });
  ok('I1: no comment opener survives in a rendered title', !body.includes('<!--') && !body.includes('-->'));
  ok('I1: a forged title cannot add a marker', !body.includes('trailhead:last-audit 2000') || !/^<!-- trailhead:last-audit/m.test(body));
  const real = renderDashboard({ ...SNAP, lastAudit: AUDIT, maps: [{ number: 1, title: FORGED, openScoped: 1, total: 1 }] });
  ok('I1: with a real marker there is exactly one comment', (real.match(/<!--/g) || []).length === 1 && real.trimEnd().endsWith(AUDIT));
}
{
  // An old body whose map-title line holds a forged marker inline: only the own-line one is carried.
  const FORGED = '<!-- trailhead:last-audit 2000-01-01T00:00:00Z -->';
  const dash = { number: 33, updatedAt: 'T1', body: `Intro line.\n\n## Maps\n- [evil ${FORGED}](https://x/1): 1 open\n\n${AUDIT}\n` };
  const t = makeTracker({ dash });
  runMain(['--repo', 'o/r'], t);
  ok('I1: the own-line marker is carried, not the forged inline one', t.writes[0].includes(AUDIT) && !t.writes[0].includes('2000-01-01'));
  const t2 = makeTracker({ dash: { number: 33, updatedAt: 'T1', body: `Intro line.\n\n## Maps\n- [evil ${FORGED}](https://x/1): 1 open\n` } });
  runMain(['--repo', 'o/r'], t2);
  ok('I1: a forged inline marker alone is not carried', !t2.writes[0].includes('trailhead:last-audit'));
}

// --- self-heal ---------------------------------------------------------------
{
  const t = makeTracker({ dash: null, pinned: [] });
  const r = runMain(['--repo', 'o/r'], t);
  ok('create: issue created once with the final body, never empty', r.code === 0 && t.created.length === 1 && t.created[0].text.includes('## 🗺 Maps') && t.created[0].text.trim() !== '');
  ok('create: labelled trailhead:dashboard, no placeholder write after', t.created[0].args.includes('trailhead:dashboard') && t.writes.length === 0);
  ok('create: pinned', t.pins.length === 1 && /NODE_77|id=NODE_77/.test(t.pins[0]));
  ok('create: summary names the new issue', /^dashboard #77: 3 maps/.test(r.out) && /created/.test(r.out));
}
{
  const t = makeTracker({ pinned: [2, 3] });
  const r = runMain(['--repo', 'o/r'], t);
  ok('re-pin: an unpinned dashboard is pinned again', r.code === 0 && t.pins.length === 1 && /NODE_33/.test(t.pins[0]));
}
{
  const t = makeTracker({ dash: null, pinned: [] });
  const r = runMain(['--repo', 'o/r', '--set-last-audit', '2026-10-14T09:30:00Z'], t);
  ok('create with --set-last-audit: marker in the first body', t.created[0].text.includes('trailhead:last-audit 2026-10-14T09:30:00Z'));
  const ghost = makeTracker({ dash: null, pinned: [] });
  const guardHit = runMain(['--repo', 'o/r'], ghost, { guard: { scan: () => 'github token' } });
  ok('create: a secret in the generated body aborts the create', guardHit.code === 1 && ghost.created.length === 0);
}

// --- guards ------------------------------------------------------------------
{
  const t = makeTracker();
  t.maps[0].title = '🗺 leak ghp_' + 'a'.repeat(36);
  const r = runMain(['--repo', 'o/r'], t);
  ok('secret in the whole generated body: abort, nothing written', r.code === 1 && /secret/.test(r.out) && t.writes.length === 0);
  const t2 = makeTracker();
  const r2 = runMain(['--repo', 'o/r'], t2, { guard: null });
  ok('no guard module: fail closed', r2.code === 1 && /secret-scan unavailable/.test(r2.out) && t2.writes.length === 0);
  const t3 = makeTracker({ dash: { number: 33, body: '', updatedAt: 'T1' } });
  const r3 = runMain(['--repo', 'o/r'], t3);
  ok('empty existing body: refused, nothing written', r3.code === 1 && /empty/.test(r3.out) && t3.writes.length === 0);
  const t4 = makeTracker({ failOn: /issue list --label trailhead:whiteboard --state open/ });
  const r4 = runMain(['--repo', 'o/r'], t4);
  ok('a failed gather aborts, nothing written', r4.code === 1 && /^aborted: /.test(r4.out) && t4.writes.length === 0);
}

// --- dry run -----------------------------------------------------------------
{
  const t = makeTracker();
  const r = runMain(['--repo', 'o/r', '--dry-run'], t);
  ok('dry-run: exit 0, one line, sizes', r.code === 0 && r.out.split('\n').filter(Boolean).length === 1 && /dry-run/.test(r.out) && /body \d+ -> \d+ bytes/.test(r.out));
  ok('dry-run: writes nothing', t.writes.length === 0 && t.created.length === 0 && t.pins.length === 0 && !t.calls.some((c) => c.startsWith('label create')));
  const m = makeTracker({ dash: null, pinned: [] });
  const r2 = runMain(['--repo', 'o/r', '--dry-run'], m);
  ok('dry-run: a missing dashboard is reported, not created', r2.code === 0 && /would create/.test(r2.out) && m.created.length === 0 && m.pins.length === 0);
}

// --- usage errors ------------------------------------------------------------
for (const argv of [['--bogus'], ['--repo'], ['--repo', 'nope'], ['--set-last-audit'], ['extra']]) {
  const t = makeTracker();
  const r = runMain(argv, t);
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2 && r.err.length > 0 && r.out === '' && t.calls.length === 0);
}

// --- end-to-end with a failing fake gh on PATH --------------------------------
{
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-bin-'));
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const res = spawnSync('node', [scriptPath, '--repo', 'o/r'], { encoding: 'utf8', env: { ...process.env, PATH: binDir + path.delimiter + process.env.PATH } });
  ok('e2e: gh failing aborts with exit 1 and one line', res.status === 1 && /^aborted: /.test(res.stdout) && res.stdout.trim().split('\n').length === 1);
  const bad = spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', bad.status === 2);
}

console.log(`dashboard.test.js: ${passed} checks passed`);
