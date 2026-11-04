#!/usr/bin/env node
// Tests for templates/trailhead-inbox-needs-info.js. Run: node inbox-needs-info.test.js
// No framework: plain asserts, same style as uat-backfill.test.js.
//
// Layers covered:
//   1. main() against a fake tracker behind an injected `gh` runner: the
//      classification, the reporter match, the days config, failed reads.
//   2. End-to-end: the script itself with a fake `gh` on PATH (multi-page read,
//      failing read).
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-inbox-needs-info.js');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-needs-info-'));
const NOW = new Date('2026-06-30T12:00:00Z');
const LABELED = '2026-06-10T12:00:00Z'; // 20 days before NOW

// issues: [{number,title,author,labeledAt?,labelEvents?,comments?,failEvents?,failComments?}]
function makeTracker(init = {}) {
  const t = { issues: init.issues || [], failList: !!init.failList, calls: [] };
  const res = (rows, status = 0) => ({ status, stdout: rows.map((r) => JSON.stringify(r)).join('\n'), stderr: status ? 'forced failure' : '' });
  t.gh = (args) => {
    t.calls.push(args.join(' '));
    if (args[0] !== 'api') return res([], 1);
    const url = args[2];
    if (url.includes('/issues?labels=trailhead:needs-info&state=open&per_page=100')) {
      if (t.failList) return res([], 1);
      return res(t.issues.map((i) => ({ number: i.number, title: i.title || `T${i.number}`, author: i.author === undefined ? 'reporter' : i.author })));
    }
    const m = /\/issues\/(\d+)\/(events|comments)/.exec(url);
    if (!m) return res([], 1);
    const i = t.issues.find((x) => x.number === Number(m[1]));
    if (m[2] === 'events') {
      if (i.failEvents) return res([], 1);
      return res(i.labelEvents || [{ at: i.labeledAt || LABELED }]);
    }
    if (i.failComments) return res([], 1);
    return res(i.comments || []);
  };
  return t;
}

function run(t, { root, env, argv } = {}) {
  let out = '';
  const code = main(argv || ['--repo', 'o/r', '--config-root', root || tmp], {
    gh: t.gh, now: () => NOW, env: env || { CLAUDE_CONFIG_DIR: path.join(tmp, 'noglobal') }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json };
}

const nums = (a) => a.map((x) => x.number);

// --- classification ----------------------------------------------------------
{
  const t = makeTracker({ issues: [
    { number: 1, comments: [{ author: 'reporter', at: '2026-06-05T00:00:00Z' }] }, // before the label
    { number: 2, comments: [{ author: 'someone', at: '2026-06-11T00:00:00Z' }] }, // other user after
    { number: 3, comments: [{ author: 'reporter', at: '2026-06-11T00:00:00Z' }] }, // reporter after
    { number: 4, author: 'Reporter', comments: [{ author: 'reporter', at: '2026-06-12T00:00:00Z' }] }, // case-different login
    { number: 5, comments: [{ author: 'reporter', at: LABELED }] }, // same-second tie
    { number: 6, author: null, comments: [] }, // deleted reporter
    { number: 7, author: 'ghost', comments: [{ author: 'ghost', at: '2026-06-12T00:00:00Z' }] },
    { number: 8, labeledAt: '2026-06-25T12:00:00Z' }, // 5 days: still waiting
    { number: 9, labeledAt: '2026-06-16T12:00:00Z' }, // exactly 14 days: timed out
    { number: 10, labeledAt: '2026-06-16T12:00:01Z' }, // 13 whole days: waiting
    { number: 11, labelEvents: [] }, // no label event
    { number: 12, failEvents: true },
    { number: 13, failComments: true },
    { number: 14, labelEvents: [{ at: '2026-05-01T00:00:00Z' }, { at: '2026-06-25T12:00:00Z' }], comments: [{ author: 'reporter', at: '2026-06-01T00:00:00Z' }] }, // latest label wins
  ] });
  const r = run(t);
  ok('exit 0, one JSON line', r.code === 0 && r.json.status === 'ok' && r.out.trim().split('\n').length === 1);
  ok('answered: reporter after the label, case-insensitive', JSON.stringify(nums(r.json.answered)) === '[3,4]');
  ok('answered carries answeredAt and author', r.json.answered[0].answeredAt === '2026-06-11T00:00:00Z' && r.json.answered[0].author === 'reporter');
  ok('timedOut: before-label comment, other user, tie, 14 whole days', JSON.stringify(nums(r.json.timedOut)) === '[1,2,5,9]');
  ok('timedOut carries ageDays', r.json.timedOut.find((x) => x.number === 9).ageDays === 14);
  ok('waiting stays out of answered and timedOut', JSON.stringify(nums(r.json.waiting)) === '[8,10,14]');
  ok('unknown: deleted reporter, ghost, no event, failed reads', JSON.stringify(nums(r.json.unknown)) === '[6,7,11,12,13]' && r.json.unknown.every((u) => u.reason));
  ok('the default is 14 days', r.json.days === 14 && r.json.warnings.length === 0);
  ok('read-only: only api reads, pull requests filtered by jq', t.calls.every((c) => c.startsWith('api ')) && t.calls[0].includes('select(.pull_request == null)'));
  ok('comments are read since the label', t.calls.some((c) => c.includes('/issues/3/comments?since=2026-06-10T12:00:00Z&per_page=100')));
}

// --- days config -------------------------------------------------------------
function configRoot(cfg) {
  const root = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.mkdirSync(path.join(root, '.trailhead'));
  if (cfg !== undefined) fs.writeFileSync(path.join(root, '.trailhead', 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return root;
}
function globalEnv(cfg) {
  const dir = fs.mkdtempSync(path.join(tmp, 'glob-'));
  fs.mkdirSync(path.join(dir, 'trailhead'));
  fs.writeFileSync(path.join(dir, 'trailhead', 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return { CLAUDE_CONFIG_DIR: dir };
}
const one = () => makeTracker({ issues: [{ number: 1, labeledAt: '2026-06-25T12:00:00Z' }] }); // 5 days old
{
  const r = run(one(), { root: configRoot({ 'inbox.needs_info_days': 3 }) });
  ok('project override: flat key', r.json.days === 3 && r.json.timedOut.length === 1);
  const n = run(one(), { root: configRoot({ inbox: { needs_info_days: 7 } }) });
  ok('project override: nested key', n.json.days === 7 && n.json.waiting.length === 1);
  const b = run(one(), { root: configRoot({ 'inbox.needs_info_days': 3, inbox: { needs_info_days: 9 } }) });
  ok('flat key wins over nested in one file', b.json.days === 3);
  const g = run(one(), { root: configRoot({}), env: globalEnv({ 'inbox.needs_info_days': 4 }) });
  ok('global config applies when the project sets nothing', g.json.days === 4);
  const p = run(one(), { root: configRoot({ 'inbox.needs_info_days': 2 }), env: globalEnv({ 'inbox.needs_info_days': 4 }) });
  ok('project wins over global', p.json.days === 2);
}
for (const bad of [0, -1, 1.5, '7', null]) {
  const r = run(one(), { root: configRoot({ 'inbox.needs_info_days': bad }), env: globalEnv({ 'inbox.needs_info_days': 6 }) });
  ok(`invalid value ${JSON.stringify(bad)} warns and falls to the global layer`, r.json.days === 6 && r.json.warnings.length === 1);
}
{
  const r = run(one(), { root: configRoot('{nope') });
  ok('invalid JSON warns and falls to the default', r.json.days === 14 && r.json.warnings.length === 1);
  const d = run(one(), { root: path.join(tmp, 'missing-root') });
  ok('a missing project config is silent', d.json.days === 14 && d.json.warnings.length === 0);
}

// --- failures and usage ------------------------------------------------------
{
  const r = run(makeTracker({ issues: [{ number: 1 }], failList: true }));
  ok('a failed list read is status error, exit 1', r.code === 1 && r.json.status === 'error');
}
for (const argv of [['--bogus'], ['--repo'], ['--repo', 'nope', '--config-root', 'x'], ['--repo', 'o/r'], ['--config-root', 'x']]) {
  const t = makeTracker();
  const r = run(t, { argv });
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2 && t.calls.length === 0);
}

// --- end-to-end with a fake gh on PATH ---------------------------------------
function e2e(script) {
  const binDir = fs.mkdtempSync(path.join(tmp, 'bin-'));
  fs.writeFileSync(path.join(binDir, 'gh'), script, { mode: 0o755 });
  return spawnSync('node', [scriptPath, '--repo', 'o/r', '--config-root', tmp], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'noglobal'), PATH: binDir + path.delimiter + process.env.PATH } });
}
{
  // Two pages for each read: one JSON document per line, as `--jq ... | tojson` prints.
  const good = e2e(`#!/bin/sh
case "$*" in
  *"issues?labels="*) echo '{"number":5,"title":"A","author":"rep"}'; echo '{"number":6,"title":"B","author":"rep"}' ;;
  *"/issues/5/events"*) echo '{"at":"2026-01-01T00:00:00Z"}'; echo '{"at":"2026-01-02T00:00:00Z"}' ;;
  *"/issues/6/events"*) echo '{"at":"2026-01-01T00:00:00Z"}' ;;
  *"/issues/5/comments"*) echo '{"author":"rep","at":"2026-01-03T00:00:00Z"}' ;;
  *"/issues/6/comments"*) echo '{"author":"x","at":"2026-01-03T00:00:00Z"}' ;;
  *) exit 1 ;;
esac
`);
  const j = JSON.parse(good.stdout.trim());
  ok('e2e: multi-page reads classify answered and timed out', good.status === 0 && JSON.stringify(nums(j.answered)) === '[5]' && JSON.stringify(nums(j.timedOut)) === '[6]');
  const partial = e2e(`#!/bin/sh
case "$*" in
  *"issues?labels="*) echo '{"number":5,"title":"A","author":"rep"}' ;;
  *"/issues/5/events"*) echo '{"at":"2026-01-01T00:00:00Z"}' ;;
  *"/issues/5/comments"*) echo '{"author":"rep","at":"2026-01-03T00:00:00Z"}'; exit 1 ;;
  *) exit 1 ;;
esac
`);
  const p = JSON.parse(partial.stdout.trim());
  ok('e2e: a read that fails after printing is unknown, never classified', partial.status === 0 && nums(p.unknown).join() === '5' && p.answered.length === 0 && p.timedOut.length === 0);
  const down = e2e('#!/bin/sh\nexit 1\n');
  ok('e2e: gh failing exits 1 with one JSON error line', down.status === 1 && JSON.parse(down.stdout.trim()).status === 'error');
  const bad = spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', bad.status === 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`inbox-needs-info.test.js: ${passed} checks passed`);
