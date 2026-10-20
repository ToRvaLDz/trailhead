#!/usr/bin/env node
// Tests for templates/trailhead-auto-run.js. Run: node auto-run.test.js
// No framework: plain asserts, same style as work-state.test.js.
//
// Layers covered:
//   1. sanitizeRecord() / parseArgs() pure.
//   2. main() with injected cwd/env/stdout/stderr against mkdtemp folders.
//   3. Fault injection: an fs whose write, read or unlink throws.
//   4. End-to-end: spawnSync of the script, including a simulated compaction.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-auto-run.js');
const { main, parseArgs, sanitizeRecord } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-auto-run-test-'));
const recPath = (dir) => path.join(dir, '.trailhead', 'auto-run.json');
const readRec = (dir) => JSON.parse(fs.readFileSync(recPath(dir), 'utf8'));
const trailheadFiles = (dir) => fs.existsSync(path.join(dir, '.trailhead')) ? fs.readdirSync(path.join(dir, '.trailhead')) : [];
const fixedNow = () => new Date('2026-10-20T10:00:00.000Z');

// Esegue main() catturando stdout e stderr; ritorna { code, lines, err }.
function run(argv, { cwd = '/', env = {}, fsMod } = {}) {
  const chunks = [];
  const errChunks = [];
  const code = main(argv, {
    cwd,
    env,
    now: fixedNow(),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: (s) => errChunks.push(String(s)) },
    ...(fsMod ? { fs: fsMod } : {}),
  });
  const lines = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code, lines, err: errChunks.join('') };
}

const START = (dir, extra = []) => ['start', '--repo', dir, '--scope', 'map:12', '--slots', '2', '--review', '2', ...extra];

// --- start -------------------------------------------------------------------
{
  const dir = mktmp();
  const r = run(START(dir), { env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  const rec = readRec(dir);
  ok('start: exit 0, one line, status written', r.code === 0 && r.lines.length === 1 && r.lines[0].status === 'written');
  ok('start: output carries path and record', r.lines[0].path === recPath(dir) && r.lines[0].record.scope === 'map:12');
  ok('start: exact key set', JSON.stringify(Object.keys(rec)) ===
    JSON.stringify(['version', 'scope', 'slots', 'review', 'session', 'skip', 'unmerged', 'startedAt', 'updatedAt']));
  ok('start: values', rec.version === 1 && rec.scope === 'map:12' && rec.slots === 2 && rec.review === '2');
  ok('start: empty lists', Array.isArray(rec.skip) && rec.skip.length === 0 && Array.isArray(rec.unmerged) && rec.unmerged.length === 0);
  ok('start: session from env', rec.session === 'sess-1');
  ok('start: timestamps ISO and equal', rec.startedAt === '2026-10-20T10:00:00.000Z' && rec.updatedAt === rec.startedAt);
  ok('start: no temp file left', JSON.stringify(trailheadFiles(dir)) === JSON.stringify(['auto-run.json']));
}

// --- session null (Codex) ----------------------------------------------------
{
  const dir = mktmp();
  run(START(dir), { env: {} });
  ok('start: session unset -> null', readRec(dir).session === null);
  const dir2 = mktmp();
  run(START(dir2), { env: { CLAUDE_CODE_SESSION_ID: '' } });
  ok('start: session empty -> null', readRec(dir2).session === null);
}

// --- scope / review tokens ---------------------------------------------------
for (const scope of ['whiteboard', 'everything', 'map:7']) {
  const dir = mktmp();
  const r = run(['start', '--repo', dir, '--scope', scope, '--slots', '1', '--review', 'config']);
  ok(`start: scope ${scope} accepted`, r.code === 0 && readRec(dir).scope === scope);
}
for (const review of ['config', '1', '2', '3', 'until', 'skip']) {
  const dir = mktmp();
  const r = run(['start', '--repo', dir, '--scope', 'everything', '--slots', '4', '--review', review]);
  ok(`start: review ${review} accepted`, r.code === 0 && readRec(dir).review === review);
}

// --- start on an existing record ---------------------------------------------
{
  const dir = mktmp();
  run(START(dir));
  run(['skip', '--repo', dir, '--ticket', '5']);
  const r = run(['start', '--repo', dir, '--scope', 'everything', '--slots', '3', '--review', 'until']);
  ok('start over existing: exists with the old record', r.code === 0 && r.lines[0].status === 'exists' && r.lines[0].record.scope === 'map:12');
  ok('start over existing: nothing written', readRec(dir).scope === 'map:12' && readRec(dir).skip[0] === 5);
  const r2 = run(['start', '--repo', dir, '--scope', 'everything', '--slots', '3', '--review', 'until', '--replace']);
  const rec = readRec(dir);
  ok('start --replace: written fresh', r2.lines[0].status === 'written' && rec.scope === 'everything' && rec.slots === 3 && rec.review === 'until' && rec.skip.length === 0);
}
{
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(recPath(dir), '{not json');
  const r = run(START(dir));
  ok('start over corrupt: exists, no record, file untouched', r.lines[0].status === 'exists' && r.lines[0].record === null && fs.readFileSync(recPath(dir), 'utf8') === '{not json');
  const r2 = run(START(dir, ['--replace']));
  ok('start --replace over corrupt: written', r2.lines[0].status === 'written' && readRec(dir).scope === 'map:12');
}

// --- read --------------------------------------------------------------------
{
  const dir = mktmp();
  const r = run(['read', '--repo', dir]);
  ok('read: absent', r.code === 0 && r.lines[0].status === 'absent' && trailheadFiles(dir).length === 0);
}
{
  const dir = mktmp();
  run(START(dir), { env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  const same = run(['read', '--repo', dir], { env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  ok('read: found with record', same.lines[0].status === 'found' && same.lines[0].record.slots === 2);
  ok('read: sameSession true', same.lines[0].sameSession === true);
  const other = run(['read', '--repo', dir], { env: { CLAUDE_CODE_SESSION_ID: 'sess-2' } });
  ok('read: sameSession false for another session', other.lines[0].sameSession === false);
  const none = run(['read', '--repo', dir], { env: {} });
  ok('read: sameSession false when the reader has no session', none.lines[0].sameSession === false);
}
{
  const dir = mktmp();
  run(START(dir), { env: {} });
  const r = run(['read', '--repo', dir], { env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  ok('read: sameSession false when the record has no session', r.lines[0].sameSession === false);
  const r2 = run(['read', '--repo', dir], { env: {} });
  ok('read: sameSession false when both sessions are null', r2.lines[0].sameSession === false);
}
{
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(recPath(dir), '{not json');
  const r = run(['read', '--repo', dir]);
  ok('read: unparseable is corrupt', r.code === 0 && r.lines[0].status === 'corrupt');
  for (const patch of [{ version: 2 }, { scope: 'nope' }, { slots: 9 }, { slots: 0 }, { review: 'x' }, { version: undefined }, { scope: undefined }, { slots: undefined }, { review: undefined }]) {
    const base = { version: 1, scope: 'whiteboard', slots: 1, review: 'config', session: null, skip: [], unmerged: [], startedAt: 'a', updatedAt: 'b' };
    fs.writeFileSync(recPath(dir), JSON.stringify({ ...base, ...patch }));
    const rr = run(['read', '--repo', dir]);
    ok(`read: invalid required field ${JSON.stringify(patch)} is corrupt`, rr.code === 0 && rr.lines[0].status === 'corrupt');
  }
  fs.writeFileSync(recPath(dir), '[1,2]');
  ok('read: array is corrupt', run(['read', '--repo', dir]).lines[0].status === 'corrupt');
  fs.writeFileSync(recPath(dir), 'null');
  ok('read: null is corrupt', run(['read', '--repo', dir]).lines[0].status === 'corrupt');
}
{
  // Voci di lista invalide: scartate, il record resta found.
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(recPath(dir), JSON.stringify({
    version: 1, scope: 'everything', slots: 2, review: 'skip', session: 's', startedAt: 'a', updatedAt: 'b',
    skip: [9, 3, 'x', -1, 0, 1.5, 3],
    unmerged: [
      { ticket: 4, branch: 'trailhead/t4', files: ['a.js', 7, ''], mergeTicket: 11 },
      { ticket: 'x', branch: 'trailhead/t5', files: [], mergeTicket: null },
      { ticket: 6, branch: '', files: [], mergeTicket: null },
      { ticket: 7, branch: 'a\nb', files: [], mergeTicket: null },
      { ticket: 8, branch: 'trailhead/t8', files: 'nope', mergeTicket: 'z' },
      'junk',
    ],
  }));
  const r = run(['read', '--repo', dir]);
  const rec = r.lines[0].record;
  ok('read: partial list entries -> found', r.lines[0].status === 'found');
  ok('read: skip sanitized, deduped, sorted', JSON.stringify(rec.skip) === JSON.stringify([3, 9]));
  ok('read: unmerged invalid entries dropped', rec.unmerged.length === 2 && rec.unmerged[0].ticket === 4 && rec.unmerged[1].ticket === 8);
  ok('read: unmerged fields normalised', JSON.stringify(rec.unmerged[0].files) === JSON.stringify(['a.js']) && rec.unmerged[0].mergeTicket === 11 &&
    rec.unmerged[1].files.length === 0 && rec.unmerged[1].mergeTicket === null);
}

// --- skip --------------------------------------------------------------------
{
  const dir = mktmp();
  const r = run(['skip', '--repo', dir, '--ticket', '3']);
  ok('skip: absent record, nothing written', r.code === 0 && r.lines[0].status === 'absent' && trailheadFiles(dir).length === 0);
  run(START(dir));
  run(['skip', '--repo', dir, '--ticket', '30']);
  run(['skip', '--repo', dir, '--ticket', '4']);
  const again = run(['skip', '--repo', dir, '--ticket', '30']);
  run(['skip', '--repo', dir, '--ticket', '17']);
  ok('skip: written status and record', again.lines[0].status === 'written' && again.lines[0].record.skip.length === 2);
  ok('skip: sorted ascending, deduped', JSON.stringify(readRec(dir).skip) === JSON.stringify([4, 17, 30]));
  ok('skip: other fields kept', readRec(dir).scope === 'map:12' && readRec(dir).startedAt === '2026-10-20T10:00:00.000Z');
}
{
  const dir = mktmp();
  fs.mkdirSync(path.join(dir, '.trailhead'));
  fs.writeFileSync(recPath(dir), 'garbage');
  const r = run(['skip', '--repo', dir, '--ticket', '3']);
  ok('skip: corrupt record reported, not overwritten', r.code === 0 && r.lines[0].status === 'corrupt' && fs.readFileSync(recPath(dir), 'utf8') === 'garbage');
}

// --- unmerged ----------------------------------------------------------------
{
  const dir = mktmp();
  const r = run(['unmerged', '--repo', dir, '--ticket', '3', '--branch', 'trailhead/t3']);
  ok('unmerged: absent record, nothing written', r.code === 0 && r.lines[0].status === 'absent' && trailheadFiles(dir).length === 0);
  run(START(dir));
  const a = run(['unmerged', '--repo', dir, '--ticket', '8', '--branch', 'trailhead/t8', '--file', 'a.js', '--file', 'b/c.js']);
  ok('unmerged: insert', a.lines[0].status === 'written' && JSON.stringify(readRec(dir).unmerged) ===
    JSON.stringify([{ ticket: 8, branch: 'trailhead/t8', files: ['a.js', 'b/c.js'], mergeTicket: null }]));
  run(['unmerged', '--repo', dir, '--ticket', '5', '--branch', 'trailhead/t5']);
  ok('unmerged: no files is an empty list, sorted by ticket', JSON.stringify(readRec(dir).unmerged.map((u) => u.ticket)) === '[5,8]' && readRec(dir).unmerged[0].files.length === 0);
  run(['unmerged', '--repo', dir, '--ticket', '8', '--branch', 'trailhead/t8', '--file', 'a.js', '--file', 'b/c.js', '--merge-ticket', '99']);
  const rec = readRec(dir);
  ok('unmerged: upsert replaces the entry (no duplicate)', rec.unmerged.length === 2 && rec.unmerged.find((u) => u.ticket === 8).mergeTicket === 99);
}

// --- clear -------------------------------------------------------------------
{
  const dir = mktmp();
  ok('clear: absent', run(['clear', '--repo', dir]).lines[0].status === 'absent');
  run(START(dir));
  const r = run(['clear', '--repo', dir]);
  ok('clear: cleared and file gone', r.code === 0 && r.lines[0].status === 'cleared' && !fs.existsSync(recPath(dir)));
  ok('clear: read afterwards is absent', run(['read', '--repo', dir]).lines[0].status === 'absent');
}

// --- --repo default is cwd ---------------------------------------------------
{
  const dir = mktmp();
  run(['start', '--scope', 'whiteboard', '--slots', '1', '--review', 'skip'], { cwd: dir });
  ok('repo defaults to cwd', readRec(dir).scope === 'whiteboard');
}

// --- usage errors: exit 2, nothing written -----------------------------------
for (const argv of [
  [],
  ['nope'],
  ['start', '--scope', 'map:1', '--slots', '2'],
  ['start', '--scope', 'map:0', '--slots', '2', '--review', 'config'],
  ['start', '--scope', 'map:x', '--slots', '2', '--review', 'config'],
  ['start', '--scope', 'maps', '--slots', '2', '--review', 'config'],
  ['start', '--scope', 'everything', '--slots', '0', '--review', 'config'],
  ['start', '--scope', 'everything', '--slots', '5', '--review', 'config'],
  ['start', '--scope', 'everything', '--slots', 'two', '--review', 'config'],
  ['start', '--scope', 'everything', '--slots', '2', '--review', 'four'],
  ['start', '--scope', 'everything', '--slots', '2', '--review', 'config', '--bogus', 'x'],
  ['start', '--scope', 'everything', '--slots'],
  ['skip', '--ticket', '0'],
  ['skip', '--ticket', 'abc'],
  ['skip'],
  ['unmerged', '--ticket', '3'],
  ['unmerged', '--branch', 'trailhead/t3'],
  ['unmerged', '--ticket', '3', '--branch', ''],
  ['unmerged', '--ticket', '3', '--branch', 'a\nb'],
  ['unmerged', '--ticket', '3', '--branch', 'b', '--merge-ticket', '0'],
  ['unmerged', '--ticket', '3', '--branch', 'b', '--merge-ticket', 'q'],
  ['read', '--ticket', '3'],
  ['clear', '--replace'],
  ['skip', '--ticket', '3', '--replace'],
]) {
  const dir = mktmp();
  const withRepo = argv.length ? [argv[0], '--repo', dir, ...argv.slice(1)] : argv;
  const r = run(withRepo);
  ok(`usage error exit 2, nothing written: ${JSON.stringify(argv)}`, r.code === 2 && r.lines.length === 0 && r.err.length > 0 && trailheadFiles(dir).length === 0);
}
ok('parseArgs: --replace only on start', parseArgs(['clear', '--replace']).error !== undefined && parseArgs(START('/x', ['--replace'])).replace === true);
ok('parseArgs: --file repeatable', JSON.stringify(parseArgs(['unmerged', '--ticket', '1', '--branch', 'b', '--file', 'x', '--file', 'y']).files) === '["x","y"]');

// --- sanitizeRecord pure -----------------------------------------------------
ok('sanitizeRecord: non-object is an error', sanitizeRecord(null).error !== undefined && sanitizeRecord('x').error !== undefined);

// --- skipped path: an injected failing fs ------------------------------------
const boom = () => { throw new Error('disk on fire'); };
{
  const dir = mktmp();
  const r = run(START(dir), { fsMod: { ...fs, writeFileSync: boom } });
  ok('skipped: start with a failing write', r.code === 0 && r.lines.length === 1 && r.lines[0].status === 'skipped' && /disk on fire/.test(r.lines[0].message));
  ok('skipped: start leaves no temp file', trailheadFiles(dir).every((f) => !f.endsWith('.tmp')));
  const r2 = run(START(dir), { fsMod: { ...fs, renameSync: boom } });
  ok('skipped: start with a failing rename', r2.code === 0 && r2.lines[0].status === 'skipped' && trailheadFiles(dir).every((f) => !f.endsWith('.tmp')));
}
{
  const dir = mktmp();
  run(START(dir));
  const fail = { ...fs, writeFileSync: boom };
  const s = run(['skip', '--repo', dir, '--ticket', '3'], { fsMod: fail });
  ok('skipped: skip with a failing write', s.code === 0 && s.lines[0].status === 'skipped' && readRec(dir).skip.length === 0);
  const u = run(['unmerged', '--repo', dir, '--ticket', '3', '--branch', 'b'], { fsMod: fail });
  ok('skipped: unmerged with a failing write', u.code === 0 && u.lines[0].status === 'skipped' && readRec(dir).unmerged.length === 0);
  const rd = run(['read', '--repo', dir], { fsMod: { ...fs, readFileSync: boom } });
  ok('skipped: read with a failing read', rd.code === 0 && rd.lines[0].status === 'skipped');
  const c = run(['clear', '--repo', dir], { fsMod: { ...fs, unlinkSync: boom } });
  ok('skipped: clear with a failing unlink', c.code === 0 && c.lines[0].status === 'skipped' && fs.existsSync(recPath(dir)));
}

// --- end-to-end, simulated compaction ----------------------------------------
{
  const dir = mktmp();
  const cli = (args, env = {}) => {
    const p = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    return { code: p.status, line: JSON.parse(p.stdout.trim().split('\n').pop()) };
  };
  // Un solo processo: start + skip + unmerged (poi upsert con merge ticket).
  const writer = (args) => run(args, { env: { CLAUDE_CODE_SESSION_ID: 'sess-A' } });
  writer(['start', '--repo', dir, '--scope', 'map:42', '--slots', '3', '--review', 'until']);
  writer(['skip', '--repo', dir, '--ticket', '31']);
  writer(['skip', '--repo', dir, '--ticket', '12']);
  writer(['unmerged', '--repo', dir, '--ticket', '12', '--branch', 'trailhead/t12', '--file', 'src/a.ts', '--file', 'src/b.ts']);
  writer(['unmerged', '--repo', dir, '--ticket', '12', '--branch', 'trailhead/t12', '--file', 'src/a.ts', '--file', 'src/b.ts', '--merge-ticket', '77']);
  // Dopo la compattazione: un processo fresco rilegge tutto.
  const fresh = cli(['read', '--repo', dir], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
  const rec = fresh.line.record;
  ok('compaction: fresh process finds the record', fresh.code === 0 && fresh.line.status === 'found' && fresh.line.sameSession === true);
  ok('compaction: scope, slots, review survive', rec.scope === 'map:42' && rec.slots === 3 && rec.review === 'until');
  ok('compaction: skip list survives', JSON.stringify(rec.skip) === '[12,31]');
  ok('compaction: unmerged list survives with the merge ticket', JSON.stringify(rec.unmerged) ===
    JSON.stringify([{ ticket: 12, branch: 'trailhead/t12', files: ['src/a.ts', 'src/b.ts'], mergeTicket: 77 }]));
  const other = cli(['read', '--repo', dir], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
  ok('compaction: another session sees sameSession false', other.line.sameSession === false && other.line.record.scope === 'map:42');
  ok('cli: usage error exits 2', spawnSync(process.execPath, [scriptPath, 'nope'], { encoding: 'utf8' }).status === 2);
  ok('cli: clear then read is absent', cli(['clear', '--repo', dir]).line.status === 'cleared' && cli(['read', '--repo', dir]).line.status === 'absent');
}

console.log(`auto-run.test.js: ${passed} checks passed`);
