#!/usr/bin/env node
// Tests for templates/trailhead-unblock.js. Run: node unblock.test.js
// No framework: plain asserts, same style as needs-you.test.js.
//
// Layers covered:
//   1. main() against a fake tracker behind an injected `gh` (multi-page reads included).
//   2. Usage errors (exit 2).
//   3. End-to-end: the script itself with a fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-unblock.js');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- fake tracker ------------------------------------------------------------
// dependents: [{number, state, labels}] of the closed issue (paginated output is the
// concatenation of one JSON object per line, whatever the page size).
// blockers: { [dependent]: [{number, state}] }. failOn: blocking | blocked_by | edit.
function makeTracker(init = {}) {
  const t = { dependents: init.dependents || [], blockers: init.blockers || {}, failOn: init.failOn || null, badJson: !!init.badJson, calls: [], edits: [] };
  const res = (stdout, status = 0) => ({ status, stdout, stderr: status ? 'forced failure' : '' });
  const lines = (list) => list.map((o) => JSON.stringify(o)).join('\n') + (list.length ? '\n' : '');
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    if (args[0] === 'api') {
      const url = args.find((a) => a.startsWith('repos/'));
      const m = /issues\/(\d+)\/dependencies\/(blocking|blocked_by)$/.exec(url || '');
      if (!m) return res('', 1);
      if (t.failOn === m[2]) return res('', 1);
      if (t.badJson) return res('not json\n');
      if (m[2] === 'blocking') return res(lines(t.dependents));
      return res(lines(t.blockers[m[1]] || []));
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      if (t.failOn === 'edit') return res('', 1);
      t.edits.push(args.join(' '));
      const n = Number(args[2]);
      const d = t.dependents.find((x) => x.number === n);
      if (d) d.labels = d.labels.filter((l) => l !== args[args.indexOf('--remove-label') + 1]);
      return res('');
    }
    return res('', 1);
  };
  return t;
}

function run(t, argv, extra = {}) {
  let out = '';
  let errOut = '';
  const code = main(argv, { gh: t.gh, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } }, ...extra });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json, errOut };
}

const args = ['--issue', '5', '--repo', 'o/r'];
const B = 'trailhead:blocked';

// --- last blocker closed -> label removed ------------------------------------
{
  const t = makeTracker({
    dependents: [{ number: 8, state: 'open', labels: [B, 'x'] }],
    blockers: { 8: [{ number: 5, state: 'closed' }, { number: 6, state: 'closed' }] },
  });
  const r = run(t, args);
  ok('unblock: exits 0 with status ok', r.code === 0 && r.json.status === 'ok');
  ok('unblock: the dependent is listed', JSON.stringify(r.json.unblocked) === '[8]' && r.json.stillBlocked.length === 0);
  ok('unblock: the blocked label is removed', t.edits.length === 1 && t.edits[0].includes('--remove-label trailhead:blocked') && t.edits[0].includes('-R o/r'));
  ok('unblock: the reads are paginated', t.calls.filter((c) => c.startsWith('api')).every((c) => c.includes('--paginate')));
  const again = run(t, args);
  ok('unblock: a retry is idempotent (label already gone)', again.code === 0 && again.json.unblocked.length === 0 && t.edits.length === 1);
}

// --- another blocker still open ----------------------------------------------
{
  const t = makeTracker({
    dependents: [{ number: 8, state: 'open', labels: [B] }],
    blockers: { 8: [{ number: 5, state: 'closed' }, { number: 6, state: 'open' }, { number: 7, state: 'open' }] },
  });
  const r = run(t, args);
  ok('unblock: an open blocker keeps the label', r.code === 0 && r.json.unblocked.length === 0 && t.edits.length === 0);
  ok('unblock: stillBlocked names the open blockers', r.json.stillBlocked.length === 1 && r.json.stillBlocked[0].issue === 8 && JSON.stringify(r.json.stillBlocked[0].openBlockers) === '[6,7]');
}

// --- skipped dependents -------------------------------------------------------
{
  const t = makeTracker({
    dependents: [
      { number: 8, state: 'open', labels: [] },
      { number: 9, state: 'closed', labels: [B] },
      { number: 10, state: 'open', labels: [B] },
    ],
    blockers: { 10: [{ number: 5, state: 'closed' }] },
  });
  const r = run(t, args);
  ok('unblock: a dependent without the label is skipped', !t.calls.some((c) => c.includes('issues/8/')));
  ok('unblock: a closed dependent is skipped', !t.calls.some((c) => c.includes('issues/9/')));
  ok('unblock: only the open labelled dependent is unblocked', JSON.stringify(r.json.unblocked) === '[10]');
}

// --- no dependents ------------------------------------------------------------
{
  const r = run(makeTracker(), args);
  ok('unblock: no dependents is ok and empty', r.code === 0 && r.json.status === 'ok' && r.json.unblocked.length === 0 && r.json.stillBlocked.length === 0);
}

// --- gh failures --------------------------------------------------------------
{
  const t = makeTracker({ failOn: 'blocking' });
  const r = run(t, args);
  ok('unblock: a failed dependents read is an error', r.code === 1 && r.json.status === 'error' && /dependents|blocking/.test(r.json.reason));
  ok('unblock: nothing edited after a failed read', t.edits.length === 0);
}
{
  const t = makeTracker({
    dependents: [{ number: 8, state: 'open', labels: [B] }, { number: 9, state: 'open', labels: [B] }],
    blockers: { 8: [{ number: 5, state: 'closed' }], 9: [{ number: 5, state: 'closed' }] },
    failOn: 'blocked_by',
  });
  const r = run(t, args);
  ok('unblock: a failed blockers read is an error naming the step', r.code === 1 && r.json.status === 'error' && /blocked_by|blockers/.test(r.json.reason));
  ok('unblock: nothing further edited after the failure', t.edits.length === 0 && t.calls.filter((c) => c.includes('issues/9/')).length === 0);
}
{
  const t = makeTracker({
    dependents: [{ number: 8, state: 'open', labels: [B] }, { number: 9, state: 'open', labels: [B] }],
    blockers: { 8: [{ number: 5, state: 'closed' }], 9: [{ number: 5, state: 'closed' }] },
    failOn: 'edit',
  });
  const r = run(t, args);
  ok('unblock: a failed label removal is an error', r.code === 1 && r.json.status === 'error' && /remove/.test(r.json.reason));
  ok('unblock: the next dependent is not touched after a failed edit', t.calls.filter((c) => c.startsWith('issue edit')).length === 1);
}
{
  const r = run(makeTracker({ badJson: true }), args);
  ok('unblock: unparseable gh output is an error', r.code === 1 && r.json.status === 'error' && /unparseable/.test(r.json.reason));
}

// --- multi-page reads ---------------------------------------------------------
// gh api --paginate with --jq prints one object per line across every page, so a
// second page is just more lines; the fake returns them concatenated, and the helper
// must read all of them (two pages of dependents, an open blocker only on page two).
{
  const t = makeTracker({
    dependents: [
      ...Array.from({ length: 30 }, (_, i) => ({ number: 100 + i, state: 'closed', labels: [] })),
      { number: 8, state: 'open', labels: [B] },
    ],
    blockers: {
      8: [...Array.from({ length: 30 }, (_, i) => ({ number: 200 + i, state: 'closed' })), { number: 99, state: 'open' }],
    },
  });
  const r = run(t, args);
  ok('unblock: a dependent on the second page is found', r.code === 0 && r.json.stillBlocked.length === 1 && r.json.stillBlocked[0].issue === 8);
  ok('unblock: an open blocker only on the second page keeps the label', JSON.stringify(r.json.stillBlocked[0].openBlockers) === '[99]' && t.edits.length === 0);
}

// --- usage errors -------------------------------------------------------------
{
  const t = makeTracker();
  for (const [name, argv] of [
    ['no arguments', []],
    ['missing --repo', ['--issue', '5']],
    ['missing --issue', ['--repo', 'o/r']],
    ['bad --issue', ['--issue', 'x', '--repo', 'o/r']],
    ['bad --repo', ['--issue', '5', '--repo', 'nope']],
    ['unknown flag', ['--issue', '5', '--repo', 'o/r', '--force']],
    ['flag without value', ['--issue']],
  ]) {
    const r = run(t, argv);
    ok(`usage: ${name} exits 2 with stderr`, r.code === 2 && r.errOut.startsWith('usage:') && r.out === '');
  }
  ok('usage: no gh call on a usage error', t.calls.length === 0);
}

// --- end-to-end: the script with a fake gh on PATH -----------------------------
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-e2e-')));
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'case "$*" in',
    '  *dependencies/blocking*) echo \'{"number":8,"state":"open","labels":["trailhead:blocked"]}\' ;;',
    '  *dependencies/blocked_by*) echo \'{"number":5,"state":"closed"}\' ;;',
    '  *"issue edit"*) echo "$*" >> "' + path.join(dir, 'edits.log') + '" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  const r = spawnSync('node', [scriptPath, '--issue', '5', '--repo', 'o/r'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  let j = null;
  try { j = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  ok('e2e: exits 0 with one JSON line', r.status === 0 && j && j.status === 'ok' && JSON.stringify(j.unblocked) === '[8]');
  ok('e2e: the label edit reached gh', fs.readFileSync(path.join(dir, 'edits.log'), 'utf8').includes('--remove-label trailhead:blocked'));
  const bad = spawnSync('node', [scriptPath], { encoding: 'utf8' });
  ok('e2e: a usage error exits 2', bad.status === 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`unblock.test.js: ${passed} checks passed`);
