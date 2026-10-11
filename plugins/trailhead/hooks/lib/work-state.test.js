#!/usr/bin/env node
// Test per templates/trailhead-work-state.js. Run: node work-state.test.js
// Nessun framework: assert semplici, stesso stile di commit-msg-sync.test.js.
//
// Layer coperti:
//   1. mergeState() / sanitizeState() puri.
//   2. main() con cwd/env/stdout iniettati contro cartelle mkdtemp.
//   3. Iniezione di guasti: fs la cui write o rename lancia.
//   4. End-to-end: execFileSync dello script stesso.
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-work-state.js');
const { mergeState, sanitizeState, parseArgs, main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-work-state-test-'));
}

// Esegue main() catturando stdout e stderr; restituisce { code, lines, err }.
function run(argv, { cwd, env = {}, fsMod } = {}) {
  const chunks = [];
  const errChunks = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { cwd, env, stdout: { write: (s) => chunks.push(s) }, ...(fsMod ? { fs: fsMod } : {}) });
  } finally {
    process.stderr.write = realErr;
  }
  const lines = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code, lines, err: errChunks.join('') };
}

const statePath = (dir) => path.join(dir, '.trailhead', 'work-state.json');
const readState = (dir) => JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
const trailheadFiles = (dir) => fs.existsSync(path.join(dir, '.trailhead')) ? fs.readdirSync(path.join(dir, '.trailhead')) : [];

// --- fresh set ---------------------------------------------------------------
{
  const dir = mktmp();
  const r = run(['set', '--repo', dir, '--map', '12', '--ticket', '205', '--title', 'Write it', '--step', 'discuss'],
    { cwd: '/', env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  const s = readState(dir);
  ok('fresh set: exit 0', r.code === 0);
  ok('fresh set: one JSON line, status written', r.lines.length === 1 && r.lines[0].status === 'written');
  ok('fresh set: output carries path and state', r.lines[0].path === statePath(dir) && r.lines[0].state.ticket === 205);
  ok('fresh set: exact key set',
    JSON.stringify(Object.keys(s)) === JSON.stringify(['map', 'ticket', 'title', 'step', 'auto', 'autoDone', 'session', 'updatedAt']));
  ok('fresh set: values', s.map === 12 && s.ticket === 205 && s.title === 'Write it' && s.step === 'discuss' && s.auto === false);
  ok('fresh set: session from env', s.session === 'sess-1');
  ok('fresh set: updatedAt is ISO-8601', new Date(s.updatedAt).toISOString() === s.updatedAt);
  ok('fresh set: no temp file left', JSON.stringify(trailheadFiles(dir)) === JSON.stringify(['work-state.json']));
}

// --- --repo default is cwd ---------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--ticket', '1', '--step', 'plan'], { cwd: dir });
  ok('repo defaults to cwd', readState(dir).ticket === 1);
}

// --- session absent / empty --------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--ticket', '1', '--step', 'plan'], { cwd: dir, env: {} });
  ok('session absent -> null', readState(dir).session === null);
  const dir2 = mktmp();
  run(['set', '--ticket', '1', '--step', 'plan'], { cwd: dir2, env: { CLAUDE_CODE_SESSION_ID: '' } });
  ok('session empty -> null', readState(dir2).session === null);
}

// --- merge on step change ----------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--map', '12', '--ticket', '205', '--title', 'T', '--step', 'discuss'], { cwd: dir });
  const before = readState(dir);
  const r = run(['set', '--step', 'plan'], { cwd: dir });
  const s = readState(dir);
  ok('merge: step-only set exits 0', r.code === 0);
  ok('merge: step updated, rest kept', s.step === 'plan' && s.map === 12 && s.ticket === 205 && s.title === 'T');
  ok('merge: updatedAt not older', s.updatedAt >= before.updatedAt);
  const r2 = run(['set', '--auto', 'true'], { cwd: dir });
  ok('merge: auto-only set allowed on a complete file', r2.code === 0 && readState(dir).auto === true && readState(dir).step === 'plan');
  run(['set', '--auto', 'false'], { cwd: dir });
  ok('merge: auto back to false', readState(dir).auto === false);
  run(['set', '--ticket', '205', '--step', 'execute'], { cwd: dir });
  ok('merge: same ticket keeps title and map', readState(dir).title === 'T' && readState(dir).map === 12);
}

// --- new ticket resets -------------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--map', '12', '--ticket', '205', '--title', 'Old', '--step', 'verify', '--auto', 'true'], { cwd: dir });
  run(['set', '--ticket', '300', '--step', 'discuss'], { cwd: dir });
  const s = readState(dir);
  ok('new ticket: no carry-over of title/map/auto', s.ticket === 300 && s.title === null && s.map === null && s.auto === false);
}

// --- none map ----------------------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--map', 'none', '--ticket', '7', '--title', 'W', '--step', 'discuss'], { cwd: dir });
  ok('map none -> null', readState(dir).map === null);
}

// --- validation failures: exit 2, nothing written ----------------------------
for (const argv of [
  ['set', '--ticket', '0', '--step', 'plan'],
  ['set', '--ticket', 'abc', '--step', 'plan'],
  ['set', '--ticket', '1', '--step', 'nope'],
  ['set', '--ticket', '1', '--step', 'plan', '--map', '-3'],
  ['set', '--ticket', '1', '--step', 'plan', '--map', 'x'],
  ['set', '--ticket', '1', '--step', 'plan', '--auto', 'maybe'],
  ['set', '--ticket', '1', '--step', 'plan', '--auto-done', '-1'],
  ['set', '--ticket', '1', '--step', 'plan', '--auto-done', '01'],
  ['set', '--ticket', '1', '--step', 'plan', '--auto-done', '1.5'],
  ['set', '--ticket', '1', '--step', 'plan', '--auto-done', 'x'],
  ['set', '--ticket', '1', '--step', 'plan', '--bogus', 'x'],
  ['set', '--ticket', '1', '--step'],
  ['set', '--ticket', '1'],
  ['set', '--step', 'plan'],
  ['frobnicate'],
  [],
]) {
  const dir = mktmp();
  const r = run([...argv.slice(0, 1), '--repo', dir, ...argv.slice(1)], { cwd: dir });
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2);
  ok(`usage error writes stderr: ${argv.join(' ')}`, r.err.length > 0);
  ok(`usage error writes nothing: ${argv.join(' ')}`, !fs.existsSync(path.join(dir, '.trailhead')));
}

// --- title sanitising --------------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--ticket', '1', '--step', 'plan', '--title', '  a\nb\tc\u0000d  '], { cwd: dir });
  ok('title: control chars collapsed to spaces and trimmed', readState(dir).title === 'a b c d');
  run(['set', '--ticket', '2', '--step', 'plan', '--title', 'x'.repeat(500)], { cwd: dir });
  ok('title: capped at 200', readState(dir).title.length === 200);
}

// --- autoDone ----------------------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--ticket', '1', '--step', 'plan'], { cwd: dir });
  ok('autoDone: defaults to 0', readState(dir).autoDone === 0);
  ok('autoDone: parseArgs strict integer', parseArgs(['set', '--auto-done', '0']).patch.autoDone === 0
    && parseArgs(['set', '--auto-done', '12']).patch.autoDone === 12);
  run(['set', '--auto', 'true', '--auto-done', '3'], { cwd: dir });
  ok('autoDone: set with auto true', readState(dir).auto === true && readState(dir).autoDone === 3);
  run(['set', '--step', 'execute'], { cwd: dir });
  ok('autoDone: kept by a merge', readState(dir).autoDone === 3 && readState(dir).auto === true);
  run(['set', '--auto', 'false'], { cwd: dir });
  ok('autoDone: reset to 0 when auto goes false', readState(dir).autoDone === 0);
  run(['set', '--auto-done', '5'], { cwd: dir });
  ok('autoDone: ignored (0) while auto is false', readState(dir).autoDone === 0);
  run(['set', '--auto', 'true', '--auto-done', '2'], { cwd: dir });
  run(['set', '--ticket', '9', '--step', 'discuss', '--auto', 'true'], { cwd: dir });
  ok('autoDone: dropped by a ticket change unless passed again', readState(dir).autoDone === 0);
  run(['set', '--ticket', '10', '--step', 'discuss', '--auto', 'true', '--auto-done', '4'], { cwd: dir });
  ok('autoDone: kept on a ticket change when passed again', readState(dir).autoDone === 4);
  // old file without the field
  const old = mktmp();
  fs.mkdirSync(path.join(old, '.trailhead'));
  fs.writeFileSync(statePath(old), JSON.stringify({ map: null, ticket: 4, title: 'x', step: 'plan', auto: true, session: null, updatedAt: 'z' }));
  run(['set', '--step', 'execute'], { cwd: old });
  ok('autoDone: old file without the field gets 0', readState(old).autoDone === 0 && readState(old).auto === true);
  ok('autoDone: sanitizeState accepts non-negative integers only',
    sanitizeState({ autoDone: 0 }).autoDone === 0 && sanitizeState({ autoDone: 7 }).autoDone === 7
    && sanitizeState({ autoDone: -1 }).autoDone === undefined && sanitizeState({ autoDone: 1.5 }).autoDone === undefined
    && sanitizeState({ autoDone: '3' }).autoDone === undefined);
}

// --- corrupt and malformed existing file -------------------------------------
{
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(statePath(dir), '{not json');
  const r = run(['set', '--ticket', '5', '--step', 'plan'], { cwd: dir });
  ok('corrupt file: overwritten, no crash', r.code === 0 && readState(dir).ticket === 5);
}
{
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(statePath(dir), JSON.stringify({ map: 'zz', ticket: 9, title: 42, step: 'plan', auto: 'yes', session: 7 }));
  const r = run(['set', '--step', 'execute'], { cwd: dir });
  const s = readState(dir);
  ok('malformed fields dropped, valid kept', r.code === 0 && s.ticket === 9 && s.step === 'execute');
  ok('malformed fields normalised', s.map === null && s.title === null && s.auto === false);
}
{
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(statePath(dir), JSON.stringify([1, 2]));
  const r = run(['set', '--step', 'execute'], { cwd: dir });
  ok('array file is treated as empty -> usage error without ticket', r.code === 2);
}

// --- clear -------------------------------------------------------------------
{
  const dir = mktmp();
  run(['set', '--ticket', '1', '--step', 'plan'], { cwd: dir });
  const r = run(['clear'], { cwd: dir });
  ok('clear present: cleared, file gone', r.code === 0 && r.lines[0].status === 'cleared' && !fs.existsSync(statePath(dir)));
  const r2 = run(['clear', '--repo', dir], { cwd: '/' });
  ok('clear absent: absent, exit 0', r2.code === 0 && r2.lines[0].status === 'absent');
}

// --- pure functions ----------------------------------------------------------
{
  ok('sanitizeState: non-object -> {}', JSON.stringify(sanitizeState(null)) === '{}' && JSON.stringify(sanitizeState('x')) === '{}');
  const m = mergeState({ ticket: 1, step: 'plan', title: 'a', map: 3, auto: false }, { step: 'verify' });
  ok('mergeState: merges', m.ticket === 1 && m.step === 'verify' && m.title === 'a' && m.map === 3);
  const p = parseArgs(['set', '--map', 'none']);
  ok('parseArgs: map none -> null', p.patch.map === null);
}

// --- iniezione di guasti -----------------------------------------------------
for (const failing of ['writeFileSync', 'renameSync']) {
  const dir = mktmp();
  run(['set', '--ticket', '1', '--step', 'plan', '--title', 'keep'], { cwd: dir });
  const bytes = fs.readFileSync(statePath(dir));
  const broken = { ...fs, [failing]: () => { throw new Error('boom ' + failing); } };
  // writeFileSync rotto scrive comunque un parziale prima di lanciare
  if (failing === 'writeFileSync') {
    broken.writeFileSync = (p, d) => { fs.writeFileSync(p, 'partial'); throw new Error('boom'); };
  }
  const r = run(['set', '--step', 'execute'], { cwd: dir, fsMod: broken });
  ok(`failure ${failing}: exit 0, status skipped with message`, r.code === 0 && r.lines[0].status === 'skipped' && /boom/.test(r.lines[0].message));
  ok(`failure ${failing}: previous file byte-identical`, Buffer.compare(fs.readFileSync(statePath(dir)), bytes) === 0);
  ok(`failure ${failing}: no temp left`, JSON.stringify(trailheadFiles(dir)) === JSON.stringify(['work-state.json']));
}

// --- end-to-end --------------------------------------------------------------
{
  const dir = mktmp();
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'e2e' };
  const out = execFileSync('node', [scriptPath, 'set', '--repo', dir, '--map', '1', '--ticket', '2', '--title', 'E', '--step', 'discuss'], { env, encoding: 'utf8' });
  ok('e2e: one JSON line', JSON.parse(out.trim()).status === 'written');
  ok('e2e: session stamped', readState(dir).session === 'e2e');
  const bad = spawnSync('node', [scriptPath, 'set', '--repo', dir, '--step', 'nope'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', bad.status === 2);
}

console.log(`work-state.test.js: ${passed} checks passed`);
