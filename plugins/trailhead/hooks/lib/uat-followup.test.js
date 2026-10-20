#!/usr/bin/env node
// Tests for templates/trailhead-uat-followup.js (#281). Run: node uat-followup.test.js
// No framework: plain asserts. A fake tracker sits behind an injected `gh` runner;
// one end-to-end run uses a fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-uat-followup.js');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Fake tracker behind `gh api graphql`: answers GraphQL-shaped pages, 'pageSize' issues each,
// following the `after` cursor (a page index as a string).
function makeTracker(init = {}) {
  const t = { issues: init.issues || [], fail: !!init.fail, raw: init.raw, pageSize: init.pageSize || 100, respond: init.respond, calls: [], argLists: [] };
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    t.argLists.push(args);
    if (t.fail) return { status: 1, stdout: '', stderr: 'forced failure' };
    if (t.raw !== undefined) return { status: 0, stdout: t.raw, stderr: '' };
    const afterIdx = args.findIndex((x) => typeof x === 'string' && x.startsWith('after='));
    const page = afterIdx < 0 ? 0 : Number(args[afterIdx].slice('after='.length));
    if (t.respond) return { status: 0, stdout: JSON.stringify(t.respond(page)), stderr: '' };
    const slice = t.issues.slice(page * t.pageSize, (page + 1) * t.pageSize);
    const more = (page + 1) * t.pageSize < t.issues.length;
    const pageInfo = { hasNextPage: more, endCursor: more ? String(page + 1) : null };
    return { status: 0, stdout: JSON.stringify({ data: { repository: { issues: { nodes: slice, pageInfo } } } }), stderr: '' };
  };
  return t;
}

function run(t, argv) {
  let out = '';
  let errOut = '';
  const code = main(argv, { gh: t.gh, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } } });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, errOut, json };
}

const URL_ = (n, repo = 'o/r') => `https://github.com/${repo}/issues/${n}`;
const fu = (number, state, body, title = `UAT ${number}`) => ({ number, title, state, body });
const base = ['find', '--parent', '281', '--repo', 'o/r'];

// --- matching ----------------------------------------------------------------
{
  // A URL whose number runs into letters is not a pointer to that issue.
  const t = makeTracker({ issues: [fu(310, 'OPEN', 'UAT of: [P](https://github.com/o/r/issues/281abc)')] });
  const r = run(t, base);
  ok('URL with trailing letters after the number does not match', r.code === 0 && r.json.open.length === 0 && r.json.reuse === null);
}
{
  const t = makeTracker({ issues: [
    fu(300, 'OPEN', `Intro\n\nUAT of: [Parent](${URL_(281)})\n\n- [ ] step`),
    fu(301, 'OPEN', 'UAT of: #281\n- [ ] step'),
    fu(302, 'OPEN', 'See the UAT of: [P](' + URL_(281) + ') mid-line'),
    fu(303, 'OPEN', `UAT of: [P](${URL_(28)})`),
    fu(304, 'OPEN', `UAT of: [P](${URL_(2810)})`),
    fu(305, 'OPEN', 'UAT of: #28'),
    fu(306, 'OPEN', 'UAT of: #2810'),
    fu(307, 'OPEN', `UAT of: [P](${URL_(281, 'other/r')})`),
    fu(308, 'OPEN', 'no pointer at all'),
    fu(309, 'OPEN', `UAT of: [P](${URL_(281, 'O/R')})`),
    fu(310, 'OPEN', `UAT of: [P](${URL_(281)})\r\n- [ ] step`),
  ] });
  const r = run(t, base);
  const nums = r.json.open.map((x) => x.number);
  ok('matches by URL, by #n, case-insensitive repo, CRLF', JSON.stringify(nums) === '[300,301,309,310]');
  ok('ignores mid-line, prefix numbers, other repo, no pointer', !nums.some((n) => [302, 303, 304, 305, 306, 307, 308].includes(n)));
  ok('prints one JSON line with title', r.code === 0 && r.json.status === 'ok' && r.json.parent === 281 && r.json.open[0].title === 'UAT 300' && r.out.trim().split('\n').length === 1);
  ok('reuse is the lowest open', r.json.reuse === 300);
  const a0 = t.calls[0];
  ok('one graphql call with the label and both states, never issue list or search', t.calls.length === 1 && a0.includes('api graphql') && a0.includes('labels:["trailhead:uat"]') && a0.includes('states:[OPEN,CLOSED]') && !a0.includes('issue list') && !a0.includes('--search'));
  ok('owner and name go as string fields, no cursor on the first page', a0.includes('-f owner=o') && a0.includes('-f name=r') && !a0.includes('after='));
}

// --- open vs closed ------------------------------------------------------------
{
  const t = makeTracker({ issues: [
    fu(12, 'CLOSED', 'UAT of: #281'),
    fu(11, 'CLOSED', 'UAT of: #281'),
    fu(20, 'OPEN', 'UAT of: #281'),
    fu(15, 'OPEN', 'UAT of: #281'),
  ] });
  const r = run(t, base);
  ok('splits open and closed ascending', JSON.stringify(r.json.open.map((x) => x.number)) === '[15,20]' && JSON.stringify(r.json.closed.map((x) => x.number)) === '[11,12]');
  ok('reuse picks the lowest open of several', r.json.reuse === 15);
}
{
  const t = makeTracker({ issues: [fu(11, 'CLOSED', 'UAT of: #281')] });
  const r = run(t, base);
  ok('only closed: reported, reuse null', r.code === 0 && r.json.closed.length === 1 && r.json.open.length === 0 && r.json.reuse === null);
}
{
  const r = run(makeTracker({ issues: [] }), base);
  ok('none found: empty lists, reuse null', r.code === 0 && r.json.reuse === null && r.json.open.length === 0 && r.json.closed.length === 0);
}

// --- errors --------------------------------------------------------------------
{
  const r = run(makeTracker({ fail: true }), base);
  ok('gh failure is a fail-closed error', r.code === 1 && r.json.status === 'error' && typeof r.json.reason === 'string');
  const b = run(makeTracker({ raw: 'not json' }), base);
  ok('bad JSON is an error', b.code === 1 && b.json.status === 'error');
  const o = run(makeTracker({ raw: '{"a":1}' }), base);
  ok('JSON without data.repository is an error', o.code === 1 && o.json.status === 'error');
  const er = run(makeTracker({ raw: JSON.stringify({ errors: [{ message: 'boom' }], data: null }) }), base);
  ok('errors array is an error', er.code === 1 && er.json.status === 'error' && /boom/.test(er.json.reason));
  const nr = run(makeTracker({ raw: JSON.stringify({ data: { repository: null } }) }), base);
  ok('null repository is an error', nr.code === 1 && nr.json.status === 'error');
  const nn = run(makeTracker({ raw: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null } } } } }) }), base);
  ok('missing nodes is an error', nn.code === 1 && nn.json.status === 'error');
  const np = run(makeTracker({ raw: JSON.stringify({ data: { repository: { issues: { nodes: [] } } } }) }), base);
  ok('missing pageInfo is an error', np.code === 1 && np.json.status === 'error');
  const nc = run(makeTracker({ raw: JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }) }), base);
  ok('hasNextPage without a cursor is an error', nc.code === 1 && nc.json.status === 'error');
  const endless = makeTracker({ respond: (p) => ({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: String(p + 1) } } } } }) });
  const cap = run(endless, base);
  ok('page cap exceeded is an error, never a partial answer', cap.code === 1 && cap.json.status === 'error' && /page/.test(cap.json.reason) && endless.calls.length === 100);
}

// --- pagination ----------------------------------------------------------------
{
  const t = makeTracker({ pageSize: 2, issues: [
    fu(1, 'OPEN', 'x'), fu(2, 'CLOSED', 'x'), fu(3, 'OPEN', 'x'),
    fu(4, 'OPEN', 'UAT of: #281'), fu(5, 'CLOSED', 'UAT of: #281'),
  ] });
  const r = run(t, base);
  ok('follow-up on a later page is found', r.code === 0 && r.json.reuse === 4 && r.json.closed[0].number === 5);
  ok('three pages, cursor passed on later ones only', t.calls.length === 3 && !t.calls[0].includes('after=') && t.calls[1].includes('-f after=1') && t.calls[2].includes('-f after=2'));
  ok('no page uses issue list or search', t.calls.every((c) => c.includes('api graphql') && !c.includes('issue list') && !c.includes('--search')));
}

// --- usage ---------------------------------------------------------------------
for (const argv of [
  [], ['bogus'], ['find'], ['find', '--parent', '281'], ['find', '--repo', 'o/r'],
  ['find', '--parent', '0', '--repo', 'o/r'], ['find', '--parent', 'abc', '--repo', 'o/r'], ['find', '--parent', '-3', '--repo', 'o/r'],
  ['find', '--parent', '281', '--repo', 'nope'], ['find', '--parent'], ['find', '--parent', '281', '--repo'],
  ['find', '--parent', '281', '--repo', 'o/r', '--bogus', 'x'],
]) {
  const t = makeTracker();
  const r = run(t, argv);
  ok(`usage error exit 2: ${argv.join(' ') || '(none)'}`, r.code === 2 && t.calls.length === 0 && r.errOut.length > 0 && r.out === '');
}

// --- end-to-end with a fake gh on PATH ------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-followup-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const payload = JSON.stringify({ data: { repository: { issues: { nodes: [fu(7, 'OPEN', 'UAT of: #281', 'Follow-up')], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\ncat <<'EOF_JSON'\n${payload}\nEOF_JSON\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
  const res = spawnSync('node', [scriptPath, ...base], { encoding: 'utf8', env });
  ok('e2e: finds the follow-up through gh on PATH', res.status === 0 && JSON.parse(res.stdout.trim()).reuse === 7);
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const bad = spawnSync('node', [scriptPath, ...base], { encoding: 'utf8', env });
  ok('e2e: failing gh exits 1 with a JSON error line', bad.status === 1 && JSON.parse(bad.stdout.trim()).status === 'error');
  const use = spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', use.status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`uat-followup.test.js: ${passed} checks passed`);
