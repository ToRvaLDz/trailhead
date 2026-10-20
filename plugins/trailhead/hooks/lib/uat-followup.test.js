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

function makeTracker(init = {}) {
  const t = { issues: init.issues || [], fail: !!init.fail, raw: init.raw, calls: [] };
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    if (t.fail) return { status: 1, stdout: '', stderr: 'forced failure' };
    if (t.raw !== undefined) return { status: 0, stdout: t.raw, stderr: '' };
    return { status: 0, stdout: JSON.stringify(t.issues), stderr: '' };
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
  ok('gh args use the label and state all, no search', t.calls.length === 1 && t.calls[0].includes('--label trailhead:uat') && t.calls[0].includes('--state all') && t.calls[0].includes('--limit 1000') && t.calls[0].includes('-R o/r') && !t.calls[0].includes('--search'));
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
  ok('non-array JSON is an error', o.code === 1 && o.json.status === 'error');
  const many = Array.from({ length: 1000 }, (_, i) => fu(i + 1, 'OPEN', 'x'));
  const l = run(makeTracker({ issues: many }), base);
  ok('hitting the limit is an error, never a partial answer', l.code === 1 && l.json.status === 'error' && /1000/.test(l.json.reason));
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
  const payload = JSON.stringify([fu(7, 'OPEN', 'UAT of: #281', 'Follow-up')]);
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
