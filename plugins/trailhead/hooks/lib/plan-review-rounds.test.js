#!/usr/bin/env node
// Tests for templates/trailhead-plan-review-rounds.js. Run: node plan-review-rounds.test.js
// No framework: plain asserts, same style as auto-slot.test.js.
//
// Layers covered:
//   1. ask: config lookup, roster resolution, host drop, unknown names, options menu.
//   2. round: converged / continue / exhausted / no-progress / ceiling and their precedence.
//   3. Usage errors (exit 2).
//   4. End-to-end: the script itself through spawnSync.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-plan-review-rounds.js');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

function run(argv, deps = {}) {
  let out = '';
  let errOut = '';
  const code = main(argv, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } }, ...deps });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json, errOut };
}

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-rounds-')));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// A project root and a global config dir holding the given config objects (null = no file).
function setup(project, global) {
  const root = tmp();
  const gdir = tmp();
  if (project !== null && project !== undefined) {
    fs.mkdirSync(path.join(root, '.trailhead'), { recursive: true });
    fs.writeFileSync(path.join(root, '.trailhead', 'config.json'), typeof project === 'string' ? project : JSON.stringify(project));
  }
  if (global !== null && global !== undefined) {
    fs.mkdirSync(path.join(gdir, 'trailhead'), { recursive: true });
    fs.writeFileSync(path.join(gdir, 'trailhead', 'config.json'), typeof global === 'string' ? global : JSON.stringify(global));
  }
  return { root, gdir, done: () => { rm(root); rm(gdir); } };
}

// Deps with a fixed set of binaries "on PATH" and a canned kimi --help.
const deps = (gdir, installed, kimiHelp = '--output-format json') => ({
  env: { CLAUDE_CONFIG_DIR: gdir, PATH: '/nowhere' },
  which: (name) => installed.includes(name),
  kimiHelp: () => kimiHelp,
});

const ask = (s, installed, extra = [], kimiHelp) => run(['ask', '--repo', s.root, ...extra], deps(s.gdir, installed, kimiHelp));
const values = (r) => r.json.options.map((o) => o.value);

// --- ask: skip ---------------------------------------------------------------
{
  const s = setup({}, null);
  const r = ask(s, ['codex', 'gemini']);
  ok('ask: plan_review unset is skip off', r.code === 0 && r.json.status === 'skip' && r.json.reason === 'off' && r.json.configured === 2);
  s.done();
}
{
  const s = setup({ plan_review: 'off', 'plan_review.rounds': 4 }, null);
  const r = ask(s, ['codex']);
  ok('ask: plan_review off is skip off with the configured rounds', r.json.status === 'skip' && r.json.reason === 'off' && r.json.configured === 4);
  s.done();
}
{
  const s = setup({ plan_review: 'on' }, null);
  const r = ask(s, []);
  ok('ask: on with nothing installed is skip no-reviewer', r.code === 0 && r.json.status === 'skip' && r.json.reason === 'no-reviewer');
  const own = ask(s, ['claude']);
  ok('ask: only the host CLI installed is skip no-reviewer', own.json.status === 'skip' && own.json.reason === 'no-reviewer');
  const codexHost = ask(s, ['codex'], ['--host', 'codex']);
  ok('ask: --host codex drops codex', codexHost.json.status === 'skip' && codexHost.json.reason === 'no-reviewer');
  const claudeOnCodex = ask(s, ['claude'], ['--host', 'codex']);
  ok('ask: --host codex keeps claude as an independent reviewer', claudeOnCodex.json.status === 'ask' && JSON.stringify(claudeOnCodex.json.reviewers) === '["claude"]');
  s.done();
}

// --- ask: roster resolution --------------------------------------------------
{
  const s = setup({ plan_review: 'on' }, null);
  const r = ask(s, ['claude', 'codex', 'gemini', 'agy', 'cursor-agent', 'not-in-roster']);
  ok('ask: on resolves the whole roster minus the host, in roster order', r.json.status === 'ask' && JSON.stringify(r.json.reviewers) === JSON.stringify(['gemini', 'codex', 'agy', 'cursor-agent']));
  ok('ask: on ignores binaries outside the roster', !r.json.reviewers.includes('not-in-roster') && r.json.unknown.length === 0);
  ok('ask: reports the configured count', r.json.configured === 2);
  s.done();
}
{
  const s = setup({ plan_review: 'codex, gemini' }, null);
  const r = ask(s, ['codex', 'gemini', 'qwen']);
  ok('ask: a comma list restricts the candidates', JSON.stringify(r.json.reviewers) === JSON.stringify(['codex', 'gemini']));
  const only = ask(s, ['gemini']);
  ok('ask: a listed CLI that is not installed is not counted', JSON.stringify(only.json.reviewers) === '["gemini"]' && only.json.unknown.length === 0);
  s.done();
}

// --- ask: kimi probe ---------------------------------------------------------
{
  const s = setup({ plan_review: 'kimi' }, null);
  ok('ask: kimi counts when --help mentions --output-format', ask(s, ['kimi'], [], 'usage: kimi --output-format').json.status === 'ask');
  const legacy = ask(s, ['kimi'], [], 'usage: kimi [--print]');
  ok('ask: legacy kimi (no --output-format) does not count', legacy.json.status === 'skip' && legacy.json.reason === 'no-reviewer');
  const noHelp = ask(s, ['kimi'], [], null);
  ok('ask: a failing kimi --help does not count', noHelp.json.status === 'skip');
  let probes = 0;
  const o = run(['ask', '--repo', s.root], { ...deps(s.gdir, []), kimiHelp: () => { probes++; return '--output-format'; } });
  ok('ask: kimi is not probed when its binary is absent', probes === 0 && o.json.status === 'skip');
  s.done();
}

// --- ask: unknown names ------------------------------------------------------
{
  const s = setup({ plan_review: 'codex,my-local,tpyo' }, null);
  const r = ask(s, ['codex', 'my-local']);
  ok('ask: a custom reviewer counts when its binary is on PATH', JSON.stringify(r.json.reviewers) === JSON.stringify(['codex', 'my-local']));
  ok('ask: a custom reviewer on PATH is not unknown', !r.json.unknown.includes('my-local'));
  ok('ask: an unknown name with no binary is listed, not counted, and warned', JSON.stringify(r.json.unknown) === '["tpyo"]' && !r.json.reviewers.includes('tpyo') && r.json.warnings.some((w) => w.includes('tpyo')));
  const typoOnly = setup({ plan_review: 'tpyo' }, null);
  const t = ask(typoOnly, ['codex']);
  ok('ask: a list of only unknown absent names is skip no-reviewer, still reporting unknown', t.json.status === 'skip' && t.json.reason === 'no-reviewer' && JSON.stringify(t.json.unknown) === '["tpyo"]');
  typoOnly.done();
  s.done();
}

// --- ask: options menu -------------------------------------------------------
{
  const mk = (rounds) => {
    const s = setup({ plan_review: 'codex', 'plan_review.rounds': rounds }, null);
    const r = ask(s, ['codex']);
    s.done();
    return r;
  };
  const r2 = mk(2);
  ok('options: n=2 is config(2) Recommended first, then 1, 3, until', JSON.stringify(values(r2)) === JSON.stringify(['config', '1', '3', 'until']) && r2.json.options[0].recommended === true && r2.json.options[0].label === 'As in config (2)');
  ok('options: only the first entry is recommended', r2.json.options.slice(1).every((o) => !o.recommended));
  ok('options: every entry has a human label', r2.json.options.every((o) => typeof o.label === 'string' && o.label.length > 0));
  ok('options: n=1 is config, 2, 3, until', JSON.stringify(values(mk(1))) === JSON.stringify(['config', '2', '3', 'until']));
  ok('options: n=3 is config, 1, 2, until', JSON.stringify(values(mk(3))) === JSON.stringify(['config', '1', '2', 'until']));
  const r5 = mk(5);
  ok('options: n=5 is config(5), 1, 2, until', JSON.stringify(values(r5)) === JSON.stringify(['config', '1', '2', 'until']) && r5.json.options[0].label === 'As in config (5)');
  ok('options: never more than four entries', [1, 2, 3, 4, 7, 12].every((n) => mk(n).json.options.length <= 4));
  ok('options: the numbered-list fallback lists all five', JSON.stringify(r2.json.fallback.map((o) => o.value)) === JSON.stringify(['config', '1', '2', '3', 'until']));
}

// --- ask: rounds fallback ----------------------------------------------------
{
  for (const bad of [0, -1, 1.5, 'two', null]) {
    const s = setup({ plan_review: 'codex', 'plan_review.rounds': bad }, null);
    const r = ask(s, ['codex']);
    ok(`rounds: ${JSON.stringify(bad)} falls back to 2 with a warning`, r.code === 0 && r.json.configured === 2 && r.json.warnings.some((w) => w.includes('plan_review.rounds')));
    s.done();
  }
  const s = setup({ plan_review: 'codex' }, null);
  const r = ask(s, ['codex']);
  ok('rounds: unset is 2 without a warning', r.json.configured === 2 && r.json.warnings.length === 0);
  s.done();
}

// --- ask: config lookup ------------------------------------------------------
{
  const s = setup({ 'plan_review.rounds': 3 }, { plan_review: 'codex', 'plan_review.rounds': 5 });
  const r = ask(s, ['codex']);
  ok('config: keys resolve one by one, nearest wins (global plan_review, project rounds)', r.json.status === 'ask' && r.json.configured === 3 && JSON.stringify(r.json.reviewers) === '["codex"]');
  s.done();
}
{
  const s = setup({ plan_review: 'off' }, { plan_review: 'on' });
  ok('config: the project value beats the global one', ask(s, ['codex']).json.reason === 'off');
  s.done();
}
{
  const s = setup(null, { plan_review: 'on' });
  ok('config: a global-only config applies', ask(s, ['codex']).json.status === 'ask');
  s.done();
}
{
  const s = setup({ plan_review: 'on' }, null);
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'trailhead'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'trailhead', 'config.json'), JSON.stringify({ 'plan_review.rounds': 4 }));
  const r = run(['ask', '--repo', s.root], { env: { HOME: home, PATH: '/nowhere' }, which: (n) => n === 'codex', kimiHelp: () => null });
  ok('config: without CLAUDE_CONFIG_DIR the global file is ~/.claude/trailhead/config.json', r.json.configured === 4);
  rm(home);
  s.done();
}

// --- ask: invalid config -----------------------------------------------------
{
  const bad = setup('{not json', null);
  const r = ask(bad, ['codex']);
  ok('error: an unparseable project config is status error, exit 1', r.code === 1 && r.json.status === 'error' && /JSON/.test(r.json.reason));
  bad.done();
  const arr = setup('[1]', null);
  ok('error: a non-object config is status error', ask(arr, ['codex']).json.status === 'error');
  arr.done();
  const gl = setup({}, '{nope');
  ok('error: an unparseable global config is status error', ask(gl, ['codex']).code === 1);
  gl.done();
  const typ = setup({ plan_review: 7 }, null);
  ok('error: a non-string plan_review is status error', ask(typ, ['codex']).json.status === 'error');
  typ.done();
  const empty = setup({ plan_review: ' , ' }, null);
  ok('error: a plan_review list with no name is status error', ask(empty, ['codex']).json.status === 'error');
  empty.done();
}
{
  const s = setup({ plan_review: 'on' }, null);
  const failing = { readFileSync: () => { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; } };
  const r = run(['ask', '--repo', s.root], { ...deps(s.gdir, ['codex']), fs: failing });
  ok('error: an unreadable config (not ENOENT) is status error', r.code === 1 && r.json.status === 'error' && /cannot read/.test(r.json.reason));
  s.done();
}

// --- ask: real PATH scan -----------------------------------------------------
{
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'qwen'), '#!/bin/sh\n', { mode: 0o644 });
  fs.mkdirSync(path.join(bin, 'codex'));
  const s = setup({ plan_review: 'on' }, null);
  const r = run(['ask', '--repo', s.root], { env: { CLAUDE_CONFIG_DIR: s.gdir, PATH: bin }, kimiHelp: () => null });
  ok('path: the default scan finds executable files only', r.json.status === 'ask' && JSON.stringify(r.json.reviewers) === '["gemini"]');
  s.done();
  rm(bin);
}

// --- round -------------------------------------------------------------------
const c = (key, text) => ({ key, text: text || `full text of ${key}` });
function round(history, choice, configured, extra = {}) {
  const dir = tmp();
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file, typeof history === 'string' ? history : JSON.stringify(history));
  const r = run(['round', '--choice', choice, '--configured', String(configured), '--history', file], extra);
  rm(dir);
  return r;
}
const decision = (r) => r.json.decision;

ok('round: a latest round with no concern is converged', decision(round([[c('a')], []], '2', 2)) === 'converged' && round([[]], 'until', 2).json.rounds === 1);
ok('round: converged carries no surviving', !('surviving' in round([[]], '1', 2).json));
ok('round: a fixed choice with rounds left continues', decision(round([[c('a')]], '2', 2)) === 'continue' && !('surviving' in round([[c('a')]], '2', 2).json));
{
  const r = round([[c('a', 'A is wrong because X'), c('b')], [c('a', 'A is still wrong because X')]], '2', 2);
  ok('round: a fixed choice with rounds spent is exhausted', decision(r) === 'exhausted');
  ok('round: exhausted surviving carries the full {key,text} of the latest round', JSON.stringify(r.json.surviving) === JSON.stringify([c('a', 'A is still wrong because X')]));
}
ok('round: config resolves to --configured', decision(round([[c('a')]], 'config', 1)) === 'exhausted' && decision(round([[c('a')]], 'config', 3)) === 'continue');
ok('round: exhausted is not reported for a fixed choice before its rounds', decision(round([[c('a')], [c('b')]], '3', 2)) === 'continue');
ok('round: a fixed choice never reports no-progress', decision(round([[c('a')], [c('a')]], '3', 2)) === 'continue');
ok('round: until continues while concerns change', decision(round([[c('a')], [c('a'), c('b')], [c('b')]], 'until', 2)) === 'continue');
ok('round: until with round 1 never reports no-progress', decision(round([[c('a')]], 'until', 2)) === 'continue');
{
  const r = round([[c('a'), c('b')], [c('a'), c('b'), c('c', 'new one')]], 'until', 2);
  ok('round: until with none of the previous concerns resolved is no-progress', decision(r) === 'no-progress' && r.json.surviving.length === 3 && r.json.surviving[2].text === 'new one');
}
ok('round: until with one previous concern resolved keeps going', decision(round([[c('a'), c('b')], [c('a')]], 'until', 2)) === 'continue');
ok('round: keys are compared normalised', decision(round([[c('  Plan  Gap ')], [c('plan gap')]], 'until', 2)) === 'no-progress');
ok('round: until at 5 rounds with progress is ceiling', decision(round([[c('a')], [c('b')], [c('c')], [c('d')], [c('e')]], 'until', 2)) === 'ceiling');
ok('round: ceiling carries surviving', round([[c('a')], [c('b')], [c('c')], [c('d')], [c('e')]], 'until', 2).json.surviving[0].key === 'e');
ok('round: until at 4 rounds still continues', decision(round([[c('a')], [c('b')], [c('c')], [c('d')]], 'until', 2)) === 'continue');
ok('round: precedence: converged beats ceiling', decision(round([[c('a')], [c('b')], [c('c')], [c('d')], []], 'until', 2)) === 'converged');
ok('round: precedence: no-progress beats ceiling at round 5', decision(round([[c('a')], [c('b')], [c('c')], [c('d')], [c('d')]], 'until', 2)) === 'no-progress');
ok('round: precedence: converged beats exhausted', decision(round([[c('a')], []], '1', 1)) === 'converged');
ok('round: output is one status ok JSON line with the round count', round([[c('a')]], '2', 2).json.status === 'ok' && round([[c('a')]], '2', 2).json.rounds === 1 && round([[c('a')]], '2', 2).out.trim().split('\n').length === 1);

// --- usage errors ------------------------------------------------------------
{
  const u = (argv) => run(argv);
  ok('usage: no command exits 2', u([]).code === 2);
  ok('usage: unknown command exits 2', u(['go', '--repo', '/x']).code === 2);
  ok('usage: ask without --repo exits 2', u(['ask']).code === 2);
  ok('usage: ask with a bad --host exits 2', u(['ask', '--repo', '/x', '--host', 'vim']).code === 2);
  ok('usage: unknown flag exits 2', u(['ask', '--repo', '/x', '--bogus', '1']).code === 2);
  ok('usage: a flag without a value exits 2', u(['ask', '--repo']).code === 2);
  ok('usage: round without --choice exits 2', u(['round', '--configured', '2', '--history', '/x']).code === 2);
  ok('usage: round with a bad --choice exits 2', u(['round', '--choice', '4', '--configured', '2', '--history', '/x']).code === 2);
  ok('usage: round without --configured exits 2', u(['round', '--choice', '1', '--history', '/x']).code === 2);
  ok('usage: round with a non-positive --configured exits 2', u(['round', '--choice', '1', '--configured', '0', '--history', '/x']).code === 2);
  ok('usage: round without --history exits 2', u(['round', '--choice', '1', '--configured', '2']).code === 2);
  ok('usage: errors go to stderr, stdout stays empty', u(['ask']).errOut.startsWith('usage:') && u(['ask']).out === '');
  ok('usage: history that is not JSON exits 2', round('{nope', '2', 2).code === 2);
  ok('usage: history that is not an array exits 2', round({ a: 1 }, '2', 2).code === 2);
  ok('usage: an empty history exits 2', round([], '2', 2).code === 2);
  ok('usage: a round that is not an array exits 2', round([{}], '2', 2).code === 2);
  ok('usage: a concern that is a bare string exits 2', round([['a']], '2', 2).code === 2);
  ok('usage: a concern with an empty key exits 2', round([[{ key: ' ', text: 'x' }]], '2', 2).code === 2);
  ok('usage: a concern with an empty text exits 2', round([[{ key: 'a', text: '' }]], '2', 2).code === 2);
  ok('usage: a concern with a non-string text exits 2', round([[{ key: 'a', text: 3 }]], '2', 2).code === 2);
  const missing = run(['round', '--choice', '1', '--configured', '2', '--history', '/nowhere/h.json']);
  ok('usage: a missing history file is status error, exit 1', missing.code === 1 && missing.json.status === 'error');
}

// --- end-to-end --------------------------------------------------------------
{
  const s = setup({ plan_review: 'on' }, null);
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
  const res = spawnSync(process.execPath, [scriptPath, 'ask', '--repo', s.root], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: s.gdir, PATH: bin } });
  const j = JSON.parse(res.stdout.trim());
  ok('e2e: ask prints one JSON line and exits 0', res.status === 0 && j.status === 'ask' && JSON.stringify(j.reviewers) === '["gemini"]' && j.options.length === 4);
  const dir = tmp();
  const file = path.join(dir, 'h.json');
  fs.writeFileSync(file, JSON.stringify([[c('a')]]));
  const rr = spawnSync(process.execPath, [scriptPath, 'round', '--choice', '1', '--configured', '2', '--history', file], { encoding: 'utf8' });
  const rj = JSON.parse(rr.stdout.trim());
  ok('e2e: round prints the decision and exits 0', rr.status === 0 && rj.decision === 'exhausted' && rj.surviving[0].key === 'a');
  ok('e2e: usage error exits 2', spawnSync(process.execPath, [scriptPath, '--bogus'], { encoding: 'utf8' }).status === 2);
  const bad = setup('{nope', null);
  ok('e2e: an invalid config exits 1', spawnSync(process.execPath, [scriptPath, 'ask', '--repo', bad.root], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: bad.gdir } }).status === 1);
  bad.done(); s.done(); rm(bin); rm(dir);
}

console.log(`plan-review-rounds.test.js: ${passed} checks passed`);
