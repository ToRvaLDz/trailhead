#!/usr/bin/env node
// Tests for templates/trailhead-merge-ticket.js (#287). Run: node merge-ticket.test.js
// No framework: plain asserts. A fake tracker sits behind an injected `gh` runner;
// one end-to-end run uses a fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-merge-ticket.js');
const { main, decodeMarker, encodeMarker } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const fakeGuard = { scan: (text) => (/ghp_[A-Za-z0-9]{20,}/.test(text) ? 'github token' : null) };
const EM_DASH = String.fromCharCode(0x2014);

// Fake tracker: open issues with labels, ticket titles, edit history, GraphQL pages.
function makeTracker(init = {}) {
  const t = {
    issues: init.issues || [], // { number, title, body, url, labels, updatedAt, edits }
    titles: init.titles || { 5: 'Ticket five', 7: 'Ticket seven', 9: 'Ticket nine', 40: 'The map' },
    next: init.next || 100,
    calls: [], created: [], edits: [], edges: [],
    listFail: !!init.listFail, listRaw: init.listRaw, listCalls: 0, pageSize: init.pageSize || 100,
    respond: init.respond, edgeFail: !!init.edgeFail, secondListSeesTwo: !!init.secondListSeesTwo,
    onEdit: init.onEdit || null, onView: init.onView || null, views: 0, writeDelta: init.writeDelta === undefined ? 1 : init.writeDelta,
    garble: !!init.garble,
  };
  const find = (n) => t.issues.find((i) => i.number === n);
  t.add = (issue) => { t.issues.push({ url: `https://github.com/o/r/issues/${issue.number}`, updatedAt: 'T1', edits: 3, labels: [], ...issue }); };
  t.touch = (n, body) => { const i = find(n); i.body = body; i.edits += 1; i.updatedAt = 'T' + (Number(i.updatedAt.slice(1)) + 1); };
  t.gh = (args) => {
    const line = args.join(' ');
    t.calls.push(line);
    const sub2 = args.slice(0, 2).join(' ');
    if (sub2 === 'api graphql') {
      const q = args.find((a) => a.startsWith('query=')) || '';
      if (q.includes('userContentEdits')) {
        const n = Number(args[args.indexOf('-F') + 1].split('=')[1]);
        return { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { userContentEdits: { totalCount: find(n).edits } } } } }), stderr: '' };
      }
      t.listCalls += 1;
      if (t.listFail) return { status: 1, stdout: '', stderr: 'forced failure' };
      if (t.listRaw !== undefined) return { status: 0, stdout: t.listRaw, stderr: '' };
      const afterArg = args.find((a) => a.startsWith('after='));
      const page = afterArg ? Number(afterArg.slice(6)) : 0;
      if (t.respond) return { status: 0, stdout: JSON.stringify(t.respond(page)), stderr: '' };
      const label = /labels:\["([^"]+)"\]/.exec(q)[1];
      let rows = t.issues.filter((i) => i.labels.includes(label) && !i.closed);
      if (t.secondListSeesTwo && t.listCalls >= 2 && t.created.length) {
        rows = rows.concat([{ number: 99, title: 'older twin', body: '<!-- trailhead:merge-ticket v1 e30= -->', url: 'https://github.com/o/r/issues/99' }]);
      }
      const slice = rows.slice(page * t.pageSize, (page + 1) * t.pageSize);
      const more = (page + 1) * t.pageSize < rows.length;
      const nodes = slice.map(({ number, title, body, url }) => ({ number, title, body, url }));
      return { status: 0, stdout: JSON.stringify({ data: { repository: { issues: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? String(page + 1) : null } } } } }), stderr: '' };
    }
    if (sub2 === 'issue view') {
      const n = Number(args[2]);
      if (args.includes('title,url')) {
        if (!t.titles[n]) return { status: 1, stdout: '', stderr: 'not found' };
        return { status: 0, stdout: JSON.stringify({ title: t.titles[n], url: `https://github.com/o/r/issues/${n}` }), stderr: '' };
      }
      t.views += 1;
      if (t.onView) t.onView(t, t.views);
      const i = find(n);
      return { status: 0, stdout: JSON.stringify({ body: i.body, updatedAt: i.updatedAt }), stderr: '' };
    }
    if (sub2 === 'issue edit') {
      const n = Number(args[2]);
      const text = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      if (t.onEdit) t.onEdit(t);
      const i = find(n);
      i.body = t.garble ? text + '\nextra' : text;
      i.edits += t.writeDelta;
      i.updatedAt = 'T' + (Number(i.updatedAt.slice(1)) + 1);
      t.edits.push({ n, text });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (sub2 === 'label create') return { status: 0, stdout: '', stderr: '' };
    if (sub2 === 'issue create') {
      const n = t.next++;
      const text = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      const labels = args.flatMap((a, k) => (args[k - 1] === '--label' ? [a] : []));
      const title = args[args.indexOf('--title') + 1];
      t.created.push({ n, title, text, labels, line });
      t.add({ number: n, title, body: text, labels });
      return { status: 0, stdout: `https://github.com/o/r/issues/${n}\n`, stderr: '' };
    }
    if (args[0] === 'api' && /^repos\/o\/r\/issues\/\d+$/.test(args[1])) {
      return { status: 0, stdout: JSON.stringify({ id: 5000 + Number(args[1].split('/').pop()), number: Number(args[1].split('/').pop()) }), stderr: '' };
    }
    if (args[0] === 'api' && args.includes('--method') && /sub_issues$/.test(args[args.indexOf('--method') + 2])) {
      t.edges.push(line);
      return t.edgeFail ? { status: 1, stdout: '', stderr: 'edge denied' } : { status: 0, stdout: '{}', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected: ' + line };
  };
  return t;
}

function run(t, argv, extra = {}) {
  let out = '';
  let errOut = '';
  const code = main(argv, { gh: t.gh, guard: fakeGuard, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } }, ...extra });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, errOut, json };
}

const add = (ticket, files, over = {}) => {
  const o = { scope: 'map-40', workspace: `/w/t${ticket}`, ...over };
  return ['add', '--scope', o.scope, '--ticket', String(ticket), ...files.flatMap((f) => ['--file', f]), '--workspace', o.workspace, '--repo', 'o/r'];
};
const writes = (t) => t.calls.filter((c) => /^issue (edit|create)/.test(c));
const MAPLABEL = 'trailhead:map-40';

// --- usage ---------------------------------------------------------------------
for (const argv of [
  [], ['bogus'], ['add'],
  add(5, []),
  add(5, ['a.js'], { scope: 'map-0' }), add(5, ['a.js'], { scope: 'map-x' }), add(5, ['a.js'], { scope: 'maps' }),
  ['add', '--scope', 'map-40', '--ticket', '0', '--file', 'a', '--workspace', '/w', '--repo', 'o/r'],
  ['add', '--scope', 'map-40', '--ticket', 'x', '--file', 'a', '--workspace', '/w', '--repo', 'o/r'],
  ['add', '--scope', 'map-40', '--ticket', '5', '--file', 'a', '--workspace', '/w', '--repo', 'nope'],
  ['add', '--scope', 'map-40', '--ticket', '5', '--file', 'a', '--repo', 'o/r'],
  ['add', '--scope', 'map-40', '--ticket', '5', '--file', 'a', '--workspace', '/w'],
  ['add', '--ticket', '5', '--file', 'a', '--workspace', '/w', '--repo', 'o/r'],
  ['add', '--scope', 'map-40', '--file', 'a', '--workspace', '/w', '--repo', 'o/r'],
  ['add', '--scope', 'map-40', '--ticket', '5', '--file'],
  ['add', '--scope', 'map-40', '--ticket', '5', '--file', 'a', '--workspace', '/w', '--repo', 'o/r', '--bogus', 'x'],
]) {
  const t = makeTracker();
  const r = run(t, argv);
  ok(`usage error exit 2: ${argv.join(' ') || '(none)'}`, r.code === 2 && t.calls.length === 0 && r.errOut.length > 0 && r.out === '');
}

// --- create on a map ------------------------------------------------------------
{
  const t = makeTracker();
  const r = run(t, add(5, ['src/a.js', 'src/b.js']));
  ok('create: ok, created, one JSON line', r.code === 0 && r.json.status === 'ok' && r.json.action === 'created' && r.json.entries === 1 && r.out.trim().split('\n').length === 1);
  ok('create: scope and issue reported', r.json.scope === 'map-40' && r.json.issue === 100 && r.json.url === 'https://github.com/o/r/issues/100' && r.json.warnings.length === 0);
  const c = t.created[0];
  ok('create: canonical title with the map title', c.title === 'Merge the branches left unmerged: The map');
  ok('create: labels ticket, task, needs-you and the map label', ['trailhead:ticket', 'trailhead:task', 'trailhead:needs-you', MAPLABEL].every((l) => c.labels.includes(l)) && c.labels.length === 4);
  ok('create: Parent line, sections and branch', /^Parent: \[The map\]\(https:\/\/github.com\/o\/r\/issues\/40\)\n/.test(c.text) && c.text.includes('## Question') && c.text.includes('## Unmerged branches') && c.text.includes('## Done when') && c.text.includes('`trailhead/t5`') && c.text.includes('[#5 Ticket five](https://github.com/o/r/issues/5)') && c.text.includes('`/w/t5`') && c.text.includes('`src/a.js`'));
  ok('create: the needs-you label is ensured first', t.calls.findIndex((x) => x.startsWith('label create trailhead:needs-you')) < t.calls.findIndex((x) => x.startsWith('issue create')) && /--color D93F0B/.test(t.calls.find((x) => x.startsWith('label create'))) && /--force/.test(t.calls.find((x) => x.startsWith('label create'))));
  ok('create: sub-issue edge wired with the new id', t.edges.length === 1 && t.edges[0] === 'api --method POST repos/o/r/issues/40/sub_issues -F sub_issue_id=5100');
  const dec = decodeMarker(c.text);
  ok('create: the marker decodes to the entry', !dec.error && dec.entries.length === 1 && dec.entries[0].ticket === 5 && dec.entries[0].branch === 'trailhead/t5' && dec.entries[0].workspace === '/w/t5' && dec.entries[0].files.join('|') === 'src/a.js|src/b.js');
  ok('create: no em-dash in the body', !c.text.includes(EM_DASH));
  ok('create: the find reads OPEN issues with the map label through graphql', t.calls[0].includes('api graphql') && t.calls[0].includes(`labels:["${MAPLABEL}"]`) && t.calls[0].includes('states:[OPEN]') && !t.calls.some((x) => x.startsWith('issue list')));
}

// --- create on the whiteboard ---------------------------------------------------
{
  const t = makeTracker();
  const r = run(t, add(7, ['x.js'], { scope: 'whiteboard' }));
  const c = t.created[0];
  ok('whiteboard: created with the whiteboard title and label', r.code === 0 && r.json.action === 'created' && r.json.scope === 'whiteboard' && c.title === 'Merge the branches left unmerged: whiteboard' && c.labels.includes('trailhead:whiteboard') && !c.labels.some((l) => l.startsWith('trailhead:map-')));
  ok('whiteboard: no Parent line and no edge', !/^Parent:/m.test(c.text) && t.edges.length === 0 && !t.calls.some((x) => x.includes('sub_issues')));
}

// --- update ----------------------------------------------------------------------
{
  const t = makeTracker();
  run(t, add(9, ['m.js', 'n.js']));
  const r2 = run(t, add(5, ['n.js', 'k.js']));
  ok('update: a second entry is appended', r2.code === 0 && r2.json.action === 'updated' && r2.json.entries === 2 && r2.json.issue === 100 && t.created.length === 1 && t.edits.length === 1);
  const body = t.edits[0].text;
  ok('update: oldest ticket first', body.indexOf('`trailhead/t5`') < body.indexOf('`trailhead/t9`') && /Suggested merge order: oldest ticket first/.test(body));
  ok('update: worded as a suggestion with a re-check note', /a suggestion, not the order the run followed/.test(body) && /re-check each later one against the trunk/.test(body));
  ok('update: also-touched-by names the other branch and the shared file', /Also touched by: `trailhead\/t9` \(`n\.js`\)/.test(body) && /Also touched by: `trailhead\/t5` \(`n\.js`\)/.test(body));
  ok('update: the Parent line is kept and the marker holds both', body.startsWith('Parent: [The map]') && decodeMarker(body).entries.map((e) => e.ticket).join() === '5,9');
  ok('update: the title is never changed', !t.calls.some((x) => /issue edit .*--title/.test(x)));
  ok('update: the guarded write ran (edit count read)', t.calls.some((x) => x.includes('userContentEdits')));
  // same ticket, same files and workspace -> unchanged
  const before = t.edits.length;
  const r3 = run(t, add(5, ['n.js', 'k.js']));
  ok('unchanged: same ticket, files and workspace writes nothing', r3.code === 0 && r3.json.action === 'unchanged' && r3.json.entries === 2 && t.edits.length === before);
  // same ticket, new files -> updated in place
  const r4 = run(t, add(5, ['n.js', 'z.js']));
  const ents = decodeMarker(t.edits[t.edits.length - 1].text).entries;
  ok('in place: new files replace the entry, no duplicate', r4.json.action === 'updated' && r4.json.entries === 2 && ents.length === 2 && ents.find((e) => e.ticket === 5).files.join() === 'n.js,z.js');
  ok('in place: the ticket is not re-read on a replace', t.calls.filter((x) => x.startsWith('issue view 5 --json title,url')).length === 1);
}

// --- find rules ------------------------------------------------------------------
{
  const e = (n) => [{ ticket: n, title: `T${n}`, url: `https://github.com/o/r/issues/${n}`, branch: `trailhead/t${n}`, workspace: `/w/${n}`, files: ['f'] }];
  const body = (n) => `Parent: [The map](https://github.com/o/r/issues/40)\n\n## Question\nq\n\n## Unmerged branches\n1. x\n\n## Done when\n- d\n\n${encodeMarker(e(n))}\n`;
  const t = makeTracker({ issues: [
    { number: 60, title: 'plain', body: 'a human note about merging, no marker at all here', labels: [MAPLABEL], url: 'https://github.com/o/r/issues/60' },
    { number: 70, title: 'merge b', body: body(9), labels: [MAPLABEL], url: 'https://github.com/o/r/issues/70' },
    { number: 80, title: 'merge c', body: body(7), labels: [MAPLABEL], url: 'https://github.com/o/r/issues/80' },
    { number: 85, title: 'other map', body: body(7), labels: ['trailhead:map-41'], url: 'https://github.com/o/r/issues/85' },
  ].map((i) => ({ updatedAt: 'T1', edits: 3, ...i })) });
  const r = run(t, add(5, ['q.js']));
  ok('reuse: the lowest-numbered open merge ticket gets the entry', r.code === 0 && r.json.action === 'updated' && r.json.issue === 70 && t.edits.length === 1 && t.edits[0].n === 70 && t.created.length === 0);
  ok('reuse: a second open one is named in a warning, none closed', r.json.warnings.length === 1 && /#70/.test(r.json.warnings[0]) && /#80/.test(r.json.warnings[0]) && !t.calls.some((x) => x.startsWith('issue close')));
  const t2 = makeTracker({ issues: [{ number: 60, title: 'plain', body: 'no marker in this body, only prose that is long enough', labels: [MAPLABEL], url: 'u' }].map((i) => ({ updatedAt: 'T1', edits: 3, ...i })) });
  const r2 = run(t2, add(5, ['q.js']));
  ok('a body without the marker is ignored: a new ticket is created', r2.code === 0 && r2.json.action === 'created' && t2.edits.length === 0);
}

// --- read errors -----------------------------------------------------------------
{
  const cases = [
    ['gh failure', makeTracker({ listFail: true })],
    ['bad JSON', makeTracker({ listRaw: 'not json' })],
    ['graphql errors', makeTracker({ listRaw: JSON.stringify({ errors: [{ message: 'boom' }], data: null }) })],
    ['no repository', makeTracker({ listRaw: JSON.stringify({ data: { repository: null } }) })],
    ['no nodes', makeTracker({ listRaw: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null } } } } }) })],
    ['no pageInfo', makeTracker({ listRaw: JSON.stringify({ data: { repository: { issues: { nodes: [] } } } }) })],
    ['cursor missing', makeTracker({ listRaw: JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }) })],
  ];
  for (const [name, t] of cases) {
    const r = run(t, add(5, ['a.js']));
    ok(`read error: ${name}: error, nothing written`, r.code === 1 && r.json.status === 'error' && writes(t).length === 0 && !t.calls.some((x) => x.startsWith('label create')));
  }
  const endless = makeTracker({ respond: (p) => ({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: String(p + 1) } } } } }) });
  const cap = run(endless, add(5, ['a.js']));
  ok('page cap exceeded is an error, never none found', cap.code === 1 && /page/.test(cap.json.reason) && endless.listCalls === 100 && writes(endless).length === 0);
}
{
  // The merge ticket sits on page two: it is found, not duplicated.
  const issues = [];
  const e = [{ ticket: 9, title: 'T9', url: 'u', branch: 'trailhead/t9', workspace: '/w', files: ['f'] }];
  for (let i = 1; i <= 3; i++) issues.push({ number: i, title: 'x', body: 'plain body without a marker', labels: [MAPLABEL] });
  issues.push({ number: 4, title: 'merge', body: `intro\n${encodeMarker(e)}\n`, labels: [MAPLABEL] });
  const t = makeTracker({ pageSize: 2, issues: issues.map((i) => ({ updatedAt: 'T1', edits: 3, url: 'u', ...i })) });
  const r = run(t, add(5, ['a.js']));
  ok('pagination: a merge ticket on a later page is found', r.code === 0 && r.json.action === 'updated' && r.json.issue === 4 && t.created.length === 0 && t.listCalls === 2);
}

// --- concurrency ------------------------------------------------------------------
{
  const seed = () => {
    const t = makeTracker();
    run(t, add(9, ['m.js']));
    t.edits.length = 0;
    return t;
  };
  const other = (n) => ({ ticket: n, title: `T${n}`, url: `https://github.com/o/r/issues/${n}`, branch: `trailhead/t${n}`, workspace: `/w/${n}`, files: ['o.js'] });
  const t = seed();
  const cur = decodeMarker(t.issues.find((i) => i.number === 100).body).entries;
  let first = true;
  t.onView = (tr, n) => { if (first && n === 2) { first = false; tr.touch(100, renderOther(cur, other(7))); } };
  function renderOther(entries, extra) {
    const { renderBody } = require(scriptPath);
    return renderBody([...entries, extra], 'Parent: [The map](https://github.com/o/r/issues/40)');
  }
  const r = run(t, add(5, ['n.js']));
  const ents = decodeMarker(t.edits[0].text).entries.map((e) => e.ticket).join();
  ok('concurrent edit that added another entry: both survive', r.code === 0 && r.json.action === 'updated' && ents === '5,7,9');
}
{
  const t = makeTracker();
  run(t, add(9, ['m.js']));
  t.edits.length = 0;
  const b = () => t.issues.find((i) => i.number === 100).body;
  t.onView = (tr, n) => { if (n === 2 || n === 3) tr.touch(100, b() + '\nnote ' + n); };
  const r = run(t, add(5, ['n.js']));
  ok('changed twice while preparing: error, nothing written', r.code === 1 && /changed twice/.test(r.json.reason) && t.edits.length === 0);
}
{
  const t = makeTracker();
  run(t, add(9, ['m.js']));
  t.edits.length = 0;
  t.onEdit = (tr) => { tr.issues.find((i) => i.number === 100).edits += 1; };
  const r = run(t, add(5, ['n.js']));
  ok('post-write conflict is an error naming it', r.code === 1 && /conflict/.test(r.json.reason));
  const t2 = makeTracker();
  run(t2, add(9, ['m.js']));
  t2.garble = true;
  const r2 = run(t2, add(5, ['n.js']));
  ok('read-back mismatch is a conflict error', r2.code === 1 && /conflict/.test(r2.json.reason));
}

// --- secrets and guard --------------------------------------------------------------
{
  const t = makeTracker();
  const r = run(t, add(5, ['ghp_' + 'a'.repeat(30) + '.js']));
  ok('secret hit on create: error, nothing written', r.code === 1 && /secret/.test(r.json.reason) && writes(t).length === 0);
  const t2 = makeTracker();
  const r2 = run(t2, add(5, ['a.js']), { guard: null });
  ok('missing guard on create: fail closed, nothing written', r2.code === 1 && /secret-scan unavailable/.test(r2.json.reason) && writes(t2).length === 0);
  const t3 = makeTracker();
  run(t3, add(9, ['m.js']));
  t3.edits.length = 0;
  const r3 = run(t3, add(5, ['ghp_' + 'b'.repeat(30) + '.js']));
  ok('secret hit on update: error, nothing written', r3.code === 1 && /secret/.test(r3.json.reason) && t3.edits.length === 0);
  const r4 = run(t3, add(5, ['a.js']), { guard: null });
  ok('missing guard on update: fail closed, nothing written', r4.code === 1 && t3.edits.length === 0);
}

// --- edge, twins, marker faults ------------------------------------------------------
{
  const t = makeTracker({ edgeFail: true });
  const r = run(t, add(5, ['a.js']));
  ok('edge failure is a warning, status ok', r.code === 0 && r.json.status === 'ok' && r.json.action === 'created' && r.json.warnings.length === 1 && /sub-issue edge/.test(r.json.warnings[0]) && /edge denied/.test(r.json.warnings[0]));
}
{
  const t = makeTracker({ secondListSeesTwo: true });
  const r = run(t, add(5, ['a.js']));
  ok('post-create find seeing two open: warning names both, nothing closed', r.code === 0 && r.json.warnings.some((w) => /#100/.test(w) && /#99/.test(w)) && !t.calls.some((x) => x.startsWith('issue close')));
}
{
  const mk = (marker) => makeTracker({ issues: [{ number: 70, title: 'm', body: `Parent: [x](y)\n\n## Question\nq\n\n${marker}\n`, labels: [MAPLABEL], url: 'u', updatedAt: 'T1', edits: 3 }] });
  for (const [name, marker] of [
    ['undecodable payload', '<!-- trailhead:merge-ticket v1 !!!not-base64-json -->'],
    ['unknown version', '<!-- trailhead:merge-ticket v2 W10= -->'],
    ['payload not an entry list', `<!-- trailhead:merge-ticket v1 ${Buffer.from('{"a":1}').toString('base64')} -->`],
    ['entry missing files', `<!-- trailhead:merge-ticket v1 ${Buffer.from('[{"ticket":1,"title":"t","url":"u","branch":"b","workspace":"w","files":[]}]').toString('base64')} -->`],
  ]) {
    const t = mk(marker);
    const r = run(t, add(5, ['a.js']));
    ok(`marker fault: ${name}: error, nothing written`, r.code === 1 && r.json.status === 'error' && /#70/.test(r.json.reason) && writes(t).length === 0 && t.created.length === 0);
  }
}

// --- round trip and rendering ---------------------------------------------------------
{
  const t = makeTracker({ titles: { 5: 'Fix `a` --> now\nsecond line <!-- [x]', 7: 'Ticket seven', 9: 'n', 40: 'The map' } });
  const weird = ['dir/a,b.js', 'we`ird`name.js', 'new\nline.js', 'plain.js'];
  const r = run(t, add(5, weird, { workspace: '/w/with `tick`' }));
  const c = t.created[0];
  const ent = decodeMarker(c.text).entries[0];
  ok('round trip: comma paths, backticks, newlines and a --> title survive intact', r.code === 0 && ent.title === 'Fix `a` --> now\nsecond line <!-- [x]' && ent.files.join('|') === weird.join('|') && ent.workspace === '/w/with `tick`');
  const visible = c.text.split('\n').filter((l) => !l.startsWith('<!-- trailhead:merge-ticket'));
  ok('rendered text: no raw newline leaks, no raw <!--, backticks fenced', visible.every((l) => !l.includes('<!--')) && c.text.includes('``we`ird`name.js``') && c.text.includes('[#5 Fix \'a\' --> now second line &lt;!-- (x)]'));
  ok('rendered text: exactly one marker line', c.text.split('\n').filter((l) => l.startsWith('<!-- trailhead:merge-ticket')).length === 1);
  r.json && ok('round trip: a repeat of the same input is unchanged', run(t, add(5, weird, { workspace: '/w/with `tick`' })).json.action === 'unchanged');
}
{
  const t = makeTracker();
  run(t, add(9, ['m.js']));
  run(t, add(5, ['n.js']));
  ok('no em-dash in any rendered body', t.edits.every((e) => !e.text.includes(EM_DASH)) && t.created.every((c) => !c.text.includes(EM_DASH)));
  ok('the decoded marker of a rendered body is stable under encode', encodeMarker(decodeMarker(t.edits[0].text).entries) === t.edits[0].text.split('\n').find((l) => l.startsWith('<!-- trailhead:merge-ticket')));
}

// --- end-to-end with a fake gh on PATH --------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ticket-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const log = path.join(tmp, 'calls.log');
  const empty = JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  const script = `#!/bin/sh
echo "$@" >> '${log}'
case "$1 $2" in
  "api graphql") cat <<'EOF_JSON'
${empty}
EOF_JSON
  ;;
  "issue view") echo '{"title":"A ticket","url":"https://github.com/o/r/issues/5"}' ;;
  "issue create") echo 'https://github.com/o/r/issues/55' ;;
  "label create") ;;
  *) case "$1" in api) echo '{"id":9955}' ;; esac ;;
esac
`;
  fs.writeFileSync(path.join(binDir, 'gh'), script, { mode: 0o755 });
  const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
  const res = spawnSync('node', [scriptPath, ...add(5, ['a.js'], { scope: 'whiteboard' })], { encoding: 'utf8', env });
  let j = null;
  try { j = JSON.parse(res.stdout.trim()); } catch { /* reported below */ }
  ok('e2e: creates through gh on PATH', res.status === 0 && j && j.action === 'created' && j.issue === 55);
  ok('e2e: gh issue create was called', fs.readFileSync(log, 'utf8').includes('issue create'));
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const bad = spawnSync('node', [scriptPath, ...add(5, ['a.js'])], { encoding: 'utf8', env });
  ok('e2e: failing gh exits 1 with a JSON error line', bad.status === 1 && JSON.parse(bad.stdout.trim()).status === 'error');
  const use = spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', use.status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`merge-ticket.test.js: ${passed} checks passed`);
