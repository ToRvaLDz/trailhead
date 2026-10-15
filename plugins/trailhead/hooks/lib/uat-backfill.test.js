#!/usr/bin/env node
// Tests for templates/trailhead-uat-backfill.js. Run: node uat-backfill.test.js
// No framework: plain asserts, same style as dashboard.test.js.
//
// Layers covered:
//   1. main() against a fake tracker behind an injected `gh` runner: what is
//      tagged, what is skipped, partial failure, the label ensure, the marker.
//   2. End-to-end: the script itself with a failing fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-uat-backfill.js');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-backfill-'));
let markerSeq = 0;
const newMarker = () => path.join(tmp, `m${markerSeq++}`, 'uat-backfill');

// --- fake tracker ------------------------------------------------------------
function makeTracker(init = {}) {
  const t = {
    issues: init.issues || [],
    labelExists: init.labelExists === undefined ? false : init.labelExists,
    createFails: !!init.createFails,
    failEdit: init.failEdit || [],
    failList: !!init.failList,
    calls: [],
    tagged: [],
  };
  const res = (stdout, status = 0) => ({ status, stdout, stderr: status ? 'forced failure' : '' });
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    if (args[0] === 'label' && args[1] === 'create') {
      if (t.createFails) return res('', 1);
      if (t.labelExists) return res('', 1); // already exists: gh exits non-zero
      t.labelExists = true;
      return res('');
    }
    if (args[0] === 'label' && args[1] === 'list') return res(JSON.stringify(t.labelExists ? [{ name: 'trailhead:uat' }] : []));
    if (args[0] === 'issue' && args[1] === 'list') {
      if (t.failList) return res('', 1);
      return res(JSON.stringify(t.issues.map((i) => ({ number: i.number, body: i.body, labels: (i.labels || []).map((name) => ({ name })) }))));
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const n = Number(args[2]);
      if (t.failEdit.includes(n)) return res('', 1);
      t.tagged.push(n);
      return res('');
    }
    return res('', 1);
  };
  return t;
}

function run(t, argv) {
  let out = '';
  const code = main(argv, { gh: t.gh, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json };
}

const uat = (n) => ({ number: n, body: `Intro\n\nUAT of: [Parent](https://github.com/o/r/issues/1)\n\n- [ ] step` });

// --- tagging -----------------------------------------------------------------
{
  const t = makeTracker({ issues: [uat(10), { number: 11, body: 'See the UAT of: thing mid-line' }, { number: 12, body: 'x', labels: [] }] });
  const r = run(t, ['--repo', 'o/r']);
  ok('tags a UAT of: line-start match', r.code === 0 && JSON.stringify(t.tagged) === '[10]');
  ok('skips a body that only mentions UAT of: mid-line', !t.tagged.includes(11));
  ok('prints one JSON line', r.json && r.json.status === 'ok' && JSON.stringify(r.json.tagged) === '[10]' && r.json.failed.length === 0 && r.out.trim().split('\n').length === 1);
  ok('ensures the label before listing', t.calls.findIndex((c) => c.startsWith('label create trailhead:uat')) < t.calls.findIndex((c) => c.startsWith('issue list')));
  ok('confirms the label with a label list', t.calls.some((c) => /^label list .*--search trailhead:uat/.test(c)));
  ok('list query excludes the label and caps at 1000', t.calls.some((c) => c.startsWith('issue list') && c.includes('-label:trailhead:uat') && c.includes('--limit 1000') && c.includes('--json number,body,labels')));
}
{
  const t = makeTracker({ issues: [{ ...uat(20), labels: ['trailhead:uat'] }, uat(21), uat(22)] });
  const r = run(t, []);
  ok('skips an already-labelled ticket, tags several', JSON.stringify(t.tagged) === '[21,22]' && JSON.stringify(r.json.tagged) === '[21,22]');
}
{
  const t = makeTracker({ issues: [uat(30), uat(31), uat(32)], failEdit: [31] });
  const mk = newMarker();
  const r = run(t, ['--marker', mk]);
  ok('a failing edit is reported and does not stop the rest', r.code === 0 && JSON.stringify(r.json.tagged) === '[30,32]' && JSON.stringify(r.json.failed) === '[31]');
  ok('a run with failed edits writes no marker', !fs.existsSync(mk));
}
{
  const t = makeTracker({ issues: [uat(40)], failList: true });
  const mk = newMarker();
  const r = run(t, ['--marker', mk]);
  ok('a failing list read exits non-zero with nothing written', r.code === 1 && t.tagged.length === 0 && r.json && r.json.status === 'error' && !fs.existsSync(mk));
}

// --- label ensure ------------------------------------------------------------
{
  const t = makeTracker({ labelExists: true, issues: [uat(50)] });
  const r = run(t, []);
  ok('an existing label (create exits non-zero) is tolerated', r.code === 0 && JSON.stringify(t.tagged) === '[50]');
}
{
  const t = makeTracker({ createFails: true, issues: [uat(51)] });
  const mk = newMarker();
  const r = run(t, ['--marker', mk]);
  ok('a create failure with the label absent is an error, nothing tagged, no marker', r.code === 1 && r.json.status === 'error' && t.tagged.length === 0 && !fs.existsSync(mk));
}

// --- marker ------------------------------------------------------------------
{
  const t = makeTracker({ issues: [uat(60)] });
  const mk = newMarker();
  const r = run(t, ['--marker', mk]);
  ok('a clean run writes the marker', r.code === 0 && fs.existsSync(mk));
  const t2 = makeTracker({ issues: [uat(61)] });
  const r2 = run(t2, ['--marker', mk]);
  ok('a present marker exits skipped without calling gh', r2.code === 0 && r2.json.status === 'skipped' && t2.calls.length === 0 && t2.tagged.length === 0);
}
{
  const t = makeTracker({ issues: [] });
  const mk = newMarker();
  const r = run(t, ['--marker', mk]);
  ok('a clean run that tags nothing still writes the marker', r.code === 0 && JSON.stringify(r.json.tagged) === '[]' && fs.existsSync(mk));
}

// --- usage -------------------------------------------------------------------
for (const argv of [['--bogus'], ['--repo'], ['--repo', 'nope'], ['--marker']]) {
  const t = makeTracker();
  const r = run(t, argv);
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2 && t.calls.length === 0);
}

// --- end-to-end with a failing fake gh on PATH --------------------------------
{
  const binDir = fs.mkdtempSync(path.join(tmp, 'bin-'));
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const mk = newMarker();
  const res = spawnSync('node', [scriptPath, '--repo', 'o/r', '--marker', mk], { encoding: 'utf8', env: { ...process.env, PATH: binDir + path.delimiter + process.env.PATH } });
  ok('e2e: gh failing exits 1 with one JSON error line and no marker', res.status === 1 && JSON.parse(res.stdout.trim()).status === 'error' && !fs.existsSync(mk));
  const bad = spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', bad.status === 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`uat-backfill.test.js: ${passed} checks passed`);
