#!/usr/bin/env node
// Tests for templates/trailhead-plan-review-rounds.js. Run: node plan-review-rounds.test.js
// No framework: plain asserts, same style as auto-slot.test.js.
//
// Layers covered:
//   1. ask: config lookup, roster resolution, host drop, unknown names, options menu.
//   2. round: converged / continue / exhausted / no-progress / ceiling and their precedence.
//   3. Usage errors (exit 2).
//   4. End-to-end: the script itself through spawnSync.
//   5. budget (pre-check of a reviewer prompt) and overflow (post-check of its output). #353.
//   6. run (a reviewer call under a wall-clock deadline), real stub scripts through spawnSync. #368.
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

// --- budget ------------------------------------------------------------------
// A prompt file of exactly n bytes (ASCII), inside its own temp dir.
function promptFile(n, name = 'brief.md') {
  const dir = tmp();
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x'.repeat(n));
  return { dir, file };
}
function budget(s, reviewer, n, extra = {}, name) {
  const p = promptFile(n, name);
  const r = run(['budget', '--repo', s.root, '--reviewer', reviewer, '--prompt', p.file], { env: { CLAUDE_CONFIG_DIR: s.gdir, PATH: '/nowhere' }, ...extra });
  rm(p.dir);
  return { ...r, file: p.file };
}
{
  const s = setup({}, null);
  const r = budget(s, 'claude', 1000);
  ok('budget: a small prompt is arg, exit 0, one JSON line', r.code === 0 && r.json.status === 'ok' && r.json.decision === 'arg' && r.out.trim().split('\n').length === 1);
  ok('budget: reports reviewer, bytes, tokens, window, cap, windowSource', r.json.reviewer === 'claude' && r.json.bytes === 1000 && r.json.tokens === 334 && r.json.window === 200000 && r.json.cap === 130000 && r.json.windowSource === 'default');
  ok('budget: arg carries no reason and no pointer, and warnings is empty', !('reason' in r.json) && !('pointer' in r.json) && Array.isArray(r.json.warnings) && r.json.warnings.length === 0);
  ok('budget: bytes === 102400 is still arg', budget(s, 'claude', 102400).json.decision === 'arg');
  ok('budget: bytes 102401 is file', budget(s, 'claude', 102401).json.decision === 'file');
  const atCap = budget(s, 'claude', 390000);
  ok('budget: tokens === cap is not skipped (file for a large prompt)', atCap.json.tokens === 130000 && atCap.json.decision === 'file');
  const over = budget(s, 'claude', 390001);
  ok('budget: tokens === cap + 1 is skip', over.json.tokens === 130001 && over.json.decision === 'skip');
  ok('budget: skip carries a reason naming estimated tokens, cap and window', /130001/.test(over.json.reason) && /130000/.test(over.json.reason) && /200000/.test(over.json.reason) && !('pointer' in over.json));
  ok('budget: skip wins over file', over.json.bytes > 102400 && over.json.decision === 'skip');
  const f = budget(s, 'gemini', 200000);
  ok('budget: file carries the pointer to the absolute prompt path', f.json.decision === 'file' && f.json.pointer === 'Read the complete review brief in ' + f.file + ' and answer it exactly as it asks.');
  const sp = budget(s, 'gemini', 200000, {}, 'my brief.md');
  ok('budget: a pointer keeps a path with spaces whole', sp.file.includes(' ') && sp.json.pointer === 'Read the complete review brief in ' + sp.file + ' and answer it exactly as it asks.');
  const windows = { claude: 200000, gemini: 1000000, codex: 272000, qwen: 256000, kimi: 256000, agy: 1000000, opencode: 128000, 'cursor-agent': 128000, coderabbit: 128000 };
  for (const [name, w] of Object.entries(windows)) {
    const r2 = budget(s, name, 10);
    ok('budget: default window for ' + name + ' is ' + w, r2.json.window === w && r2.json.cap === Math.floor(w * 0.65));
  }
  const custom = budget(s, 'my-local', 10);
  ok('budget: an unknown reviewer gets the 128000 fallback window', custom.json.window === 128000 && custom.json.windowSource === 'default');
  s.done();
}
{
  const s = setup({ 'plan_review.context': { codex: 1000 } }, { 'plan_review.context': { gemini: 5000, codex: 2000 } });
  const c1 = budget(s, 'codex', 10);
  ok('budget: the project window wins for a CLI both layers name', c1.json.window === 1000 && c1.json.cap === 650 && c1.json.windowSource === 'config');
  const g1 = budget(s, 'gemini', 10);
  ok('budget: a CLI only the global layer names is honoured', g1.json.window === 5000 && g1.json.windowSource === 'config');
  ok('budget: a CLI neither layer names keeps the default', budget(s, 'claude', 10).json.windowSource === 'default');
  const sk = budget(s, 'codex', 2000);
  ok('budget: a configured small window skips an oversized prompt', sk.json.tokens === 667 && sk.json.decision === 'skip');
  s.done();
}
{
  const s = setup({ 'plan_review.context': { codex: 0 } }, { 'plan_review.context': { codex: 2000 } });
  const r = budget(s, 'codex', 10);
  ok('budget: an invalid project entry warns and falls through to the global value', r.json.window === 2000 && r.json.windowSource === 'config' && r.json.warnings.some((w) => w.includes('plan_review.context') && w.includes('codex')));
  s.done();
}
{
  const s = setup({ 'plan_review.context': 'big' }, null);
  const r = budget(s, 'codex', 10);
  ok('budget: a non-object plan_review.context warns and is ignored', r.code === 0 && r.json.window === 272000 && r.json.windowSource === 'default' && r.json.warnings.some((w) => w.includes('plan_review.context')));
  s.done();
  const arr = setup({ 'plan_review.context': [1] }, null);
  ok('budget: an array plan_review.context is not an object, warned', budget(arr, 'codex', 10).json.warnings.length === 1);
  arr.done();
}
for (const bad of [0, -5, 1.5, '1000', 10000001, null]) {
  const s = setup({ 'plan_review.context': { codex: bad } }, null);
  const r = budget(s, 'codex', 10);
  ok('budget: context entry ' + JSON.stringify(bad) + ' is rejected with a warning', r.code === 0 && r.json.window === 272000 && r.json.windowSource === 'default' && r.json.warnings.length === 1);
  s.done();
}
{
  const s = setup({ 'plan_review.context': { codex: 10000000 } }, null);
  ok('budget: 10000000 is the largest accepted window', budget(s, 'codex', 10).json.window === 10000000);
  s.done();
  const multi = setup({ 'plan_review.context': { codex: 4000 } }, null);
  ok('budget: bytes are counted as UTF-8, not characters', (() => {
    const dir = tmp();
    const file = path.join(dir, 'u.md');
    fs.writeFileSync(file, 'é'.repeat(10));
    const r = run(['budget', '--repo', multi.root, '--reviewer', 'codex', '--prompt', file], { env: { CLAUDE_CONFIG_DIR: multi.gdir, PATH: '/nowhere' } });
    rm(dir);
    return r.json.bytes === 20 && r.json.tokens === 7;
  })());
  multi.done();
}
{
  const s = setup({}, null);
  const env = { env: { CLAUDE_CONFIG_DIR: s.gdir, PATH: '/nowhere' } };
  ok('usage: budget without --repo exits 2', run(['budget', '--reviewer', 'codex', '--prompt', '/x'], env).code === 2);
  ok('usage: budget without --reviewer exits 2', run(['budget', '--repo', s.root, '--prompt', '/x'], env).code === 2);
  ok('usage: budget without --prompt exits 2', run(['budget', '--repo', s.root, '--reviewer', 'codex'], env).code === 2);
  const u = run(['budget', '--repo', s.root], env);
  ok('usage: budget errors go to stderr, stdout stays empty', u.errOut.startsWith('usage:') && u.out === '');
  const missing = run(['budget', '--repo', s.root, '--reviewer', 'codex', '--prompt', '/nowhere/brief.md'], env);
  ok('budget: an unreadable prompt file is status error, exit 1', missing.code === 1 && missing.json.status === 'error' && /cannot read/.test(missing.json.reason));
  const bad = setup('{nope', null);
  const p = promptFile(10);
  const e = run(['budget', '--repo', bad.root, '--reviewer', 'codex', '--prompt', p.file], { env: { CLAUDE_CONFIG_DIR: bad.gdir, PATH: '/nowhere' } });
  ok('budget: an invalid config is status error, exit 1', e.code === 1 && e.json.status === 'error');
  rm(p.dir); bad.done(); s.done();
}

// --- overflow ----------------------------------------------------------------
function overflow(text, brief) {
  const dir = tmp();
  const file = path.join(dir, 'codex.out');
  fs.writeFileSync(file, text);
  const extra = [];
  if (brief !== undefined) {
    const pf = path.join(dir, 'brief.md');
    fs.writeFileSync(pf, brief);
    extra.push('--prompt', pf);
  }
  const r = run(['overflow', '--output', file, ...extra]);
  rm(dir);
  return r;
}
{
  const msgs = ['context_length_exceeded', 'This model\'s Maximum Context Length is 128000 tokens', 'Error: prompt is too long: 250000 tokens', 'input exceeds the context window of the model', 'Input is too long for requested model', 'The input token count (300000) exceeds the maximum number of tokens allowed (128000)', 'spawn E2BIG: Argument list too long'];
  for (const m of msgs) {
    const r = overflow('some output\n  ' + m + '  \nmore');
    ok('overflow: matches "' + m + '"', r.code === 0 && r.json.status === 'ok' && r.json.overflow === true && r.json.reason.includes(m) && r.json.reason === r.json.reason.trim());
  }
  ok('overflow: matching is case-insensitive', overflow('PROMPT IS TOO LONG').json.overflow === true);
  ok('overflow: the quoted reason is length-capped', overflow('prompt is too long ' + 'y'.repeat(5000)).json.reason.length <= 300);
  ok('overflow: ordinary output is not an overflow', (() => { const r = overflow('1. Risk: the plan is too long to read\nblocking: none'); return r.code === 0 && r.json.overflow === false && !('reason' in r.json); })());
  ok('overflow: a timeout is not an overflow', overflow('Error: request timed out after 540s').json.overflow === false);
  ok('overflow: an auth failure is not an overflow', overflow('401 Unauthorized: invalid API key').json.overflow === false);
  ok('overflow: a rate-limit error is not an overflow', overflow('429 Too Many Requests: rate limit reached, too many tokens per minute').json.overflow === false);
  ok('overflow: a line of the brief echoed back is not an overflow', overflow('user\n- prompt is too long -> skip\nError: request timed out', 'The PLAN:\n- prompt is too long -> skip\n').json.overflow === false);
  ok('overflow: a real error still matches with the brief passed', overflow('- prompt is too long -> skip\nError: prompt is too long: 250000 tokens', '- prompt is too long -> skip\n').json.overflow === true);
  ok('overflow: an unreadable brief file is status error, exit 1', (() => { const d = tmp(); const f = path.join(d, 'x.out'); fs.writeFileSync(f, 'prompt is too long'); const r = run(['overflow', '--output', f, '--prompt', path.join(d, 'none.md')]); rm(d); return r.code === 1 && r.json.status === 'error'; })());
  ok('overflow: an empty output file is not an overflow', overflow('').json.overflow === false);
  ok('overflow: an E2BIG line in the stderr part of a combined file is caught', overflow('partial stdout review text\n--- stderr ---\nbash: /usr/bin/codex: Argument list too long\n').json.overflow === true);
  ok('usage: overflow without --output exits 2', run(['overflow']).code === 2);
  const miss = run(['overflow', '--output', '/nowhere/x.out']);
  ok('overflow: an unreadable output file is status error, exit 1', miss.code === 1 && miss.json.status === 'error');
}

// --- budget and overflow end-to-end ------------------------------------------
{
  const s = setup({}, null);
  const p = promptFile(200000, 'brief.md');
  const res = spawnSync(process.execPath, [scriptPath, 'budget', '--repo', s.root, '--reviewer', 'gemini', '--prompt', p.file], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: s.gdir } });
  const j = JSON.parse(res.stdout.trim());
  ok('e2e: budget prints one JSON line with the file decision and exits 0', res.status === 0 && j.decision === 'file' && j.pointer.includes(p.file));
  const huge = promptFile(500000);
  const sk = spawnSync(process.execPath, [scriptPath, 'budget', '--repo', s.root, '--reviewer', 'claude', '--prompt', huge.file], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: s.gdir } });
  ok('e2e: budget skip is still exit 0 with a reason', sk.status === 0 && JSON.parse(sk.stdout.trim()).decision === 'skip');
  ok('e2e: budget usage error exits 2', spawnSync(process.execPath, [scriptPath, 'budget', '--repo', s.root], { encoding: 'utf8' }).status === 2);
  const out = path.join(p.dir, 'o.out');
  fs.writeFileSync(out, 'oops\ncontext_length_exceeded\n');
  const ov = spawnSync(process.execPath, [scriptPath, 'overflow', '--output', out], { encoding: 'utf8' });
  const oj = JSON.parse(ov.stdout.trim());
  ok('e2e: overflow prints the verdict and exits 0', ov.status === 0 && oj.overflow === true && oj.reason.includes('context_length_exceeded'));
  fs.writeFileSync(out, 'all good');
  ok('e2e: overflow false on ordinary output', JSON.parse(spawnSync(process.execPath, [scriptPath, 'overflow', '--output', out], { encoding: 'utf8' }).stdout.trim()).overflow === false);
  rm(p.dir); rm(huge.dir); s.done();
}

// --- run: a reviewer call under a deadline (#368) -------------------------------
{
  const dir = tmp();
  const out = path.join(dir, 'r.out');
  const stub = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
  const helper = (extra, cmd, env = {}) => {
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [scriptPath, 'run', '--output', out, ...extra, '--', ...cmd], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
    let json = null;
    try { json = JSON.parse(res.stdout.trim()); } catch { /* not json */ }
    return { res, json, ms: Date.now() - t0, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null };
  };
  const node = (f, ...a) => [process.execPath, f, ...a];
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const fast = helper([], node(stub('fast.js', "console.log('review text'); console.error('warn text');")));
  ok('run: fast exit 0 is status ok, exit 0, one JSON line', fast.res.status === 0 && fast.json.status === 'ok' && fast.json.exitCode === 0 && fast.json.signal === null && fast.json.timeoutSeconds === 600 && fast.json.output === out && !('reason' in fast.json) && fast.res.stdout.trim().split('\n').length === 1);
  ok('run: stdout and stderr both land in the output file', fast.text.includes('review text') && fast.text.includes('warn text'));

  const bad = helper([], node(stub('bad.js', "console.log('partial'); process.exit(3);")));
  ok('run: a non-zero exit is failed with its code, still exit 0', bad.res.status === 0 && bad.json.status === 'failed' && bad.json.exitCode === 3 && /3/.test(bad.json.reason) && bad.text.includes('partial'));

  const stdinStub = stub('stdin.js', "process.stdin.on('data', () => {}); process.stdin.on('end', () => { console.log('EOF'); });");
  const eof = helper(['--timeout', '5'], node(stdinStub));
  ok('run: stdin is closed (a reader gets EOF at once)', eof.json.status === 'ok' && eof.text.includes('EOF') && eof.ms < 4000);

  const missing = helper([], [path.join(dir, 'no-such-cli'), 'x']);
  ok('run: a missing command is status error, exit 0, text in the file', missing.res.status === 0 && missing.json.status === 'error' && missing.json.exitCode === null && /ENOENT/.test(missing.json.reason) && /ENOENT/.test(missing.text));
  const noexec = helper([], [stub('plain.txt', 'x')]);
  ok('run: a non-executable command is status error', noexec.res.status === 0 && noexec.json.status === 'error' && /EACCES/.test(noexec.text));

  const pass = helper([], node(stub('argv.js', "console.log(JSON.stringify(process.argv.slice(2)));"), '--foo', '', '--timeout', 'a b'));
  ok('run: argv after -- is passed verbatim, flags and empty strings included', pass.json.status === 'ok' && pass.text.trim() === JSON.stringify(['--foo', '', '--timeout', 'a b']));

  const sleeper = helper(['--timeout', '1'], node(stub('sleep.js', "console.log('Reading additional input from stdin...'); setTimeout(() => {}, 300000);")));
  ok('run: a silent sleeper is timeout within the bound, exit 0', sleeper.res.status === 0 && sleeper.json.status === 'timeout' && sleeper.json.timeoutSeconds === 1 && /1s/.test(sleeper.json.reason) && sleeper.ms < 6000);
  ok('run: the partial output of a timed-out call stays in the file', sleeper.text.includes('Reading additional input from stdin...'));
  const ov = run(['overflow', '--output', out]);
  ok('run: overflow on that partial output is not what classifies a timeout', ov.json.overflow === false && sleeper.json.status === 'timeout');
  const ovText = stub('ov.js', "console.log('context_length_exceeded'); setTimeout(() => {}, 300000);");
  const slow = helper(['--timeout', '1'], node(ovText));
  ok('run: timeout wins even when the output looks like an overflow', slow.json.status === 'timeout' && run(['overflow', '--output', out]).json.overflow === true);

  const pidFile = path.join(dir, 'gc.pid');
  const grand = stub('grand.js', `
const { spawn } = require('child_process');
const fs = require('fs');
process.on('SIGTERM', () => {});
const gc = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 300000);"], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
setTimeout(() => {}, 300000);
`);
  const stubborn = helper(['--timeout', '1'], node(grand), { TRAILHEAD_REVIEW_GRACE_MS: '400' });
  ok('run: a child ignoring SIGTERM still ends as timeout, killed by SIGKILL', stubborn.json.status === 'timeout' && stubborn.json.signal === 'SIGKILL' && stubborn.ms < 8000);
  const gcPid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 20 && alive(gcPid); i++) sleepMs(100);
  ok('run: the grandchild does not survive the timeout', gcPid > 0 && !alive(gcPid));

  const usage = (argv) => spawnSync(process.execPath, [scriptPath, 'run', ...argv], { encoding: 'utf8' });
  ok('usage: run without --output exits 2', usage(['--', 'true']).status === 2);
  ok('usage: run without a command exits 2', usage(['--output', out]).status === 2 && usage(['--output', out, '--']).status === 2);
  ok('usage: run with a bad --timeout exits 2', ['0', '-1', '1.5', 'abc'].every((v) => usage(['--output', out, '--timeout', v, '--', 'true']).status === 2));
  ok('usage: run with an unknown helper flag exits 2', usage(['--output', out, '--bogus', 'x', '--', 'true']).status === 2);
  const unwritable = spawnSync(process.execPath, [scriptPath, 'run', '--output', path.join(dir, 'no', 'such', 'dir', 'x.out'), '--', 'true'], { encoding: 'utf8' });
  ok('run: an unwritable output file exits 1 with status error', unwritable.status === 1 && JSON.parse(unwritable.stdout.trim()).status === 'error');
  rm(dir);
}

console.log(`plan-review-rounds.test.js: ${passed} checks passed`);
