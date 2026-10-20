#!/usr/bin/env node
// Tests for templates/trailhead-needs-you.js. Run: node needs-you.test.js
// No framework: plain asserts, same style as uat-followup.test.js.
//
// Layers covered:
//   1. main() (park, clear) against a fake tracker behind an injected `gh` and guard.
//   2. End-to-end: the script itself with a fake `gh` on PATH.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-needs-you.js');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const fakeGuard = { scan: (text) => (/ghp_[A-Za-z0-9]{20,}/.test(text) ? 'github token' : null) };

// --- fake tracker ------------------------------------------------------------
// One issue: labels [names], assignees [logins], comments [bodies]. failOn names the
// gh step that fails: ensure | view | comment | unassign | label | remove.
function makeTracker(init = {}) {
  const t = { labels: init.labels || [], assignees: init.assignees || [], comments: init.comments || [], failOn: init.failOn || null, badJson: !!init.badJson, calls: [], ensured: false };
  const res = (stdout, status = 0) => ({ status, stdout, stderr: status ? 'forced failure' : '' });
  const step = (name, fn) => (t.failOn === name ? res('', 1) : fn());
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    const [a, b] = args;
    if (a === 'label' && b === 'create') return step('ensure', () => { t.ensured = true; return res(''); });
    if (a === 'issue' && b === 'view') {
      return step('view', () => (t.badJson ? res('not json') : res(JSON.stringify({
        labels: t.labels.map((name) => ({ name })),
        assignees: t.assignees.map((login) => ({ login })),
        comments: t.comments.map((body) => ({ body })),
      }))));
    }
    if (a === 'issue' && b === 'comment') return step('comment', () => { t.comments.push(args[args.indexOf('--body') + 1]); return res(''); });
    if (a === 'issue' && b === 'edit') {
      if (args.includes('--remove-assignee')) return step('unassign', () => { t.assignees = []; return res(''); });
      if (args.includes('--add-label')) return step('label', () => { t.labels.push(args[args.indexOf('--add-label') + 1]); return res(''); });
      if (args.includes('--remove-label')) return step('remove', () => { const l = args[args.indexOf('--remove-label') + 1]; t.labels = t.labels.filter((x) => x !== l); return res(''); });
    }
    return res('', 1);
  };
  return t;
}

function run(t, argv, extra = {}) {
  let out = '';
  let errOut = '';
  const code = main(argv, { gh: t.gh, guard: fakeGuard, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } }, ...extra });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json, errOut };
}

const park = (reason = 'Decide between A and B') => ['park', '--issue', '7', '--reason', reason, '--repo', 'o/r'];
const clear = ['clear', '--issue', '7', '--repo', 'o/r'];
const idx = (t, re) => t.calls.findIndex((c) => re.test(c));

// --- park: order and output ----------------------------------------------------
{
  const t = makeTracker({ assignees: ['me'], labels: ['trailhead:ticket'] });
  const r = run(t, park());
  ok('park ok, one JSON line', r.code === 0 && r.json.status === 'ok' && r.out.trim().split('\n').length === 1);
  ok('park output fields', r.json.issue === 7 && r.json.commented === true && r.json.unassigned === true && r.json.labelled === true);
  ok('comment body is NEEDS YOU, a blank line, then the reason', t.comments[0] === 'NEEDS YOU\n\nDecide between A and B');
  const iE = idx(t, /^label create trailhead:needs-you .*--force/);
  const iV = idx(t, /^issue view 7 --json labels,assignees,comments/);
  const iC = idx(t, /^issue comment 7/);
  const iU = idx(t, /--remove-assignee @me/);
  const iL = idx(t, /--add-label trailhead:needs-you/);
  ok('call order: ensure, view, comment, unassign, label', iE >= 0 && iE < iV && iV < iC && iC < iU && iU < iL);
  ok('label ensured with the color and description', t.calls[iE].includes('--color D93F0B') && t.calls[iE].includes('--description'));
  ok('-R passed on every call', t.calls.every((c) => c.includes('-R o/r')));
  ok('final state: unassigned and labelled', t.assignees.length === 0 && t.labels.includes('trailhead:needs-you'));
}

// --- park: idempotence ---------------------------------------------------------
{
  const t = makeTracker({ assignees: ['me'] });
  run(t, park());
  const before = t.comments.length;
  const r = run(t, park('  Decide   between A\nand B '));
  ok('same reason (whitespace-normalised) posts no second comment', t.comments.length === before && r.json.commented === false);
  ok('re-park on an already-labelled unassigned ticket is ok', r.code === 0 && r.json.unassigned === false && r.json.labelled === false && t.labels.filter((l) => l === 'trailhead:needs-you').length === 1);
  const r2 = run(t, park('A different reason'));
  ok('a different reason posts a new comment', r2.json.commented === true && t.comments.length === before + 1);
  const r3 = run(t, park('Decide between A and B'));
  ok('only the latest NEEDS YOU comment is compared', r3.json.commented === true);
  const t2 = makeTracker({ comments: ['NEEDS YOUR attention\n\nx', 'unrelated'] });
  ok('a non NEEDS YOU comment does not dedup', run(t2, park('x')).json.commented === true);
}

// --- park: guards and failures --------------------------------------------------
{
  const t = makeTracker({ assignees: ['me'] });
  const r = run(t, park('token ghp_abcdefghijklmnopqrstuvwxyz0123'));
  ok('a secret in the reason writes nothing', r.code === 1 && r.json.status === 'error' && /secret/.test(r.json.reason) && t.calls.length === 0);
  const t2 = makeTracker();
  const r2 = run(t2, park(), { guard: null });
  ok('a missing guard fails closed', r2.code === 1 && r2.json.status === 'error' && t2.calls.length === 0);
}
for (const [failOn, later] of [['ensure', ['view', 'comment', 'unassign', 'label']], ['view', ['comment', 'unassign', 'label']], ['comment', ['unassign', 'label']], ['unassign', ['label']], ['label', []]]) {
  const t = makeTracker({ assignees: ['me'], failOn });
  const r = run(t, park());
  ok(`failing ${failOn} is status error, exit 1`, r.code === 1 && r.json.status === 'error' && r.json.reason.length > 0);
  ok(`after ${failOn} fails, later steps do not run`, later.every((s) => !t.calls.some((c) => ({ view: /issue view/, comment: /issue comment/, unassign: /--remove-assignee/, label: /--add-label/ })[s].test(c))));
}
{
  const t = makeTracker({ assignees: ['me'], failOn: 'unassign' });
  run(t, park());
  ok('a failed unassign leaves no label', !t.labels.includes('trailhead:needs-you'));
  const tb = makeTracker({ badJson: true });
  const r = run(tb, park());
  ok('unparseable view JSON is an error, nothing written', r.code === 1 && r.json.status === 'error' && tb.comments.length === 0);
}

// --- clear ----------------------------------------------------------------------
{
  const t = makeTracker({ labels: ['trailhead:ticket', 'trailhead:needs-you'] });
  const r = run(t, clear);
  ok('clear removes the label when present', r.code === 0 && r.json.status === 'ok' && r.json.issue === 7 && r.json.cleared === true && !t.labels.includes('trailhead:needs-you'));
  const r2 = run(t, clear);
  ok('clear is a no-op when absent', r2.code === 0 && r2.json.cleared === false && t.calls.filter((c) => /--remove-label/.test(c)).length === 1);
  const tf = makeTracker({ labels: ['trailhead:needs-you'], failOn: 'remove' });
  ok('clear errors on a failed removal', run(tf, clear).code === 1);
  const tv = makeTracker({ failOn: 'view' });
  const rv = run(tv, clear);
  ok('clear errors on a failed read', rv.code === 1 && rv.json.status === 'error');
  ok('clear errors on unparseable JSON', run(makeTracker({ badJson: true }), clear).code === 1);
}

// --- usage ----------------------------------------------------------------------
for (const argv of [[], ['bogus'], ['park'], ['park', '--issue', '7', '--repo', 'o/r'], ['park', '--issue', 'x', '--reason', 'r', '--repo', 'o/r'],
  ['park', '--issue', '7', '--reason', '  ', '--repo', 'o/r'], ['park', '--issue', '7', '--reason', 'r'], ['clear', '--issue', '7'], ['clear', '--repo', 'o/r'],
  ['clear', '--issue', '7', '--repo', 'nope'], ['clear', '--issue', '7', '--repo', 'o/r', '--reason', 'r'], ['clear', '--issue']]) {
  const t = makeTracker();
  const r = run(t, argv);
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2 && t.calls.length === 0 && r.errOut.length > 0);
}

// --- end-to-end with a fake gh on PATH --------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-you-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const log = path.join(tmp, 'calls.log');
  const script = `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "issue view"*) echo '{"labels":[{"name":"trailhead:needs-you"}],"assignees":[{"login":"me"}],"comments":[]}' ;;
  *) exit 0 ;;
esac
`;
  fs.writeFileSync(path.join(binDir, 'gh'), script, { mode: 0o755 });
  const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
  const res = spawnSync('node', [scriptPath, ...park('Needs a human call')], { encoding: 'utf8', env });
  const j = JSON.parse(res.stdout.trim());
  ok('e2e: park prints one ok JSON line', res.status === 0 && j.status === 'ok' && j.commented === true && j.unassigned === true);
  const calls = fs.readFileSync(log, 'utf8');
  ok('e2e: comment before unassign before label', calls.indexOf('issue comment') < calls.indexOf('--remove-assignee') && calls.indexOf('--remove-assignee') < calls.indexOf('--add-label'));
  const cl = spawnSync('node', [scriptPath, ...clear], { encoding: 'utf8', env });
  ok('e2e: clear removes the present label', cl.status === 0 && JSON.parse(cl.stdout.trim()).cleared === true && fs.readFileSync(log, 'utf8').includes('--remove-label trailhead:needs-you'));
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const bad = spawnSync('node', [scriptPath, ...clear], { encoding: 'utf8', env });
  ok('e2e: gh failing exits 1 with an error line', bad.status === 1 && JSON.parse(bad.stdout.trim()).status === 'error');
  ok('e2e: usage error exits 2', spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' }).status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`needs-you.test.js: ${passed} checks passed`);
