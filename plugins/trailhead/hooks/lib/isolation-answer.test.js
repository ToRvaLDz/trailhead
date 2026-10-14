#!/usr/bin/env node
// Tests for templates/trailhead-isolation-answer.js. Run: node isolation-answer.test.js
// No framework: plain asserts, same style as work-state.test.js.
//
// Layers covered:
//   1. Pure decide() / parseOthers() / parseArgs().
//   2. main() with injected cwd/stdout/now against mkdtemp folders, incl. a real
//      linked worktree resolving to the main checkout's record.
//   3. Fault injection: an fs whose write or rename throws.
//   4. End-to-end: execFileSync of the script itself.
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-isolation-answer.js');
const { decide, parseOthers, parseArgs, resolveProjectRoot, main, IDLE_WINDOW_MS } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const HOUR = 3600 * 1000;
const T0 = new Date('2026-10-14T08:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms);
const iso = (d) => d.toISOString();

function mktmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-isolation-answer-test-')));
}

// Runs main() capturing stdout and stderr; returns { code, lines, err }.
function run(argv, { cwd, now = T0, fsMod } = {}) {
  const chunks = [];
  const errChunks = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { cwd, now, stdout: { write: (s) => chunks.push(s) }, ...(fsMod ? { fs: fsMod } : {}) });
  } finally {
    process.stderr.write = realErr;
  }
  const lines = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code, lines, err: errChunks.join('') };
}

const recPath = (dir) => path.join(dir, '.trailhead', 'isolation-answer.json');
const readRec = (dir) => JSON.parse(fs.readFileSync(recPath(dir), 'utf8'));
const trailheadFiles = (dir) => fs.existsSync(path.join(dir, '.trailhead')) ? fs.readdirSync(path.join(dir, '.trailhead')) : [];
const rec = (over = {}) => ({ answer: 'no', others: [], recordedAt: iso(T0), usedAt: iso(T0), ...over });

// --- decide: every reason ----------------------------------------------------
{
  ok('window is 8 hours', IDLE_WINDOW_MS === 8 * HOUR);
  const d = (r, o, n = T0) => decide(r, o, n);
  ok('decide absent', d(null, []).status === 'ask' && d(null, []).reason === 'absent');
  ok('decide absent (undefined)', d(undefined, []).reason === 'absent');
  ok('decide reuse no', d(rec(), []).status === 'reuse' && d(rec(), []).answer === 'no');
  ok('decide reuse yes', d(rec({ answer: 'yes', others: [3] }), [3]).answer === 'yes');
  ok('decide reuse carries recordedAt', d(rec(), []).recordedAt === iso(T0));
  ok('decide unavailable always asks', d(rec(), 'unavailable').reason === 'unavailable');
  ok('decide unavailable asks even with no record', d(null, 'unavailable').reason === 'unavailable');
  ok('decide claims-changed (appeared)', d(rec(), [5]).reason === 'claims-changed');
  ok('decide claims-changed (released)', d(rec({ others: [5] }), []).reason === 'claims-changed');
  ok('decide claims-changed (swapped)', d(rec({ others: [5] }), [6]).reason === 'claims-changed');
  ok('decide fingerprint ignores order and duplicates',
    d(rec({ others: [9, 3, 3] }), [3, 9]).status === 'reuse' && d(rec({ others: [3, 9] }), [9, 3, 9]).status === 'reuse');
  // idle window edge
  ok('decide exactly 8h reuses', d(rec(), [], at(8 * HOUR)).status === 'reuse');
  ok('decide just over 8h expires', d(rec(), [], at(8 * HOUR + 1)).reason === 'expired');
  ok('decide slid usedAt keeps it alive', d(rec({ usedAt: iso(at(7 * HOUR)) }), [], at(14 * HOUR)).status === 'reuse');
  // invalid records
  for (const [name, r] of [
    ['non-object', 'x'],
    ['array', [1]],
    ['bad answer', rec({ answer: 'maybe' })],
    ['missing answer', { others: [], recordedAt: iso(T0), usedAt: iso(T0) }],
    ['others not array', rec({ others: '3' })],
    ['others zero', rec({ others: [0] })],
    ['others negative', rec({ others: [-2] })],
    ['others float', rec({ others: [1.5] })],
    ['others string member', rec({ others: ['3'] })],
    ['malformed usedAt', rec({ usedAt: 'yesterday' })],
    ['malformed recordedAt', rec({ recordedAt: 'nope' })],
    ['non-string usedAt', rec({ usedAt: 12 })],
    ['future usedAt', rec({ usedAt: iso(at(HOUR)) })],
    ['future recordedAt', rec({ recordedAt: iso(at(HOUR)) })],
  ]) ok(`decide invalid: ${name}`, d(r, []).reason === 'invalid');
}

// --- parseOthers / parseArgs -------------------------------------------------
{
  ok('parseOthers none', JSON.stringify(parseOthers('none', { allowUnavailable: false })) === '[]');
  ok('parseOthers csv sorted deduped', JSON.stringify(parseOthers('12,3,3,7', { allowUnavailable: false })) === '[3,7,12]');
  ok('parseOthers unavailable allowed for check', parseOthers('unavailable', { allowUnavailable: true }) === 'unavailable');
  for (const bad of ['unavailable', '', '0', '-1', '1,,2', '1.5', 'a', '3,x', ' 3']) {
    ok(`parseOthers rejects ${JSON.stringify(bad)}`, parseOthers(bad, { allowUnavailable: false }) === null);
  }
  ok('parseOthers rejects empty even for check', parseOthers('', { allowUnavailable: true }) === null);
  const p = parseArgs(['check', '--repo', '/x', '--others', 'none']);
  ok('parseArgs check', p.command === 'check' && p.repo === '/x' && JSON.stringify(p.others) === '[]');
  const r = parseArgs(['record', '--answer', 'yes', '--others', '4,2']);
  ok('parseArgs record', r.answer === 'yes' && JSON.stringify(r.others) === '[2,4]');
  ok('parseArgs clear', parseArgs(['clear']).command === 'clear');
  for (const argv of [
    [], ['frobnicate'], ['check'], ['check', '--others'], ['check', '--others', 'x'], ['check', '--others', 'none', '--bogus', '1'],
    ['record', '--others', 'none'], ['record', '--answer', 'yes'], ['record', '--answer', 'maybe', '--others', 'none'],
    ['record', '--answer', 'yes', '--others', 'unavailable'], ['clear', '--others', 'none'], ['clear', '--repo'],
  ]) ok(`parseArgs error: ${argv.join(' ')}`, !!parseArgs(argv).error);
}

// --- main: record / check round trip ----------------------------------------
{
  const dir = mktmp();
  const r0 = run(['check', '--repo', dir, '--others', 'none'], { cwd: '/' });
  ok('check absent: exit 0, ask absent', r0.code === 0 && r0.lines[0].status === 'ask' && r0.lines[0].reason === 'absent');
  ok('check absent: path reported, nothing written', r0.lines[0].path === recPath(dir) && !fs.existsSync(path.join(dir, '.trailhead')));

  const w = run(['record', '--repo', dir, '--answer', 'no', '--others', '9,4'], { cwd: '/' });
  const s = readRec(dir);
  ok('record: exit 0, written', w.code === 0 && w.lines.length === 1 && w.lines[0].status === 'written');
  ok('record: output carries path and record', w.lines[0].path === recPath(dir) && w.lines[0].record.answer === 'no');
  ok('record: exact key set', JSON.stringify(Object.keys(s)) === JSON.stringify(['answer', 'others', 'recordedAt', 'usedAt']));
  ok('record: values', s.answer === 'no' && JSON.stringify(s.others) === '[4,9]' && s.recordedAt === iso(T0) && s.usedAt === iso(T0));
  ok('record: no temp left', JSON.stringify(trailheadFiles(dir)) === JSON.stringify(['isolation-answer.json']));

  const r1 = run(['check', '--repo', dir, '--others', '4,9'], { cwd: '/', now: at(2 * HOUR) });
  ok('check reuse: status reuse with answer', r1.code === 0 && r1.lines[0].status === 'reuse' && r1.lines[0].answer === 'no');
  ok('check reuse: recordedAt and path', r1.lines[0].recordedAt === iso(T0) && r1.lines[0].path === recPath(dir));
  ok('check reuse: usedAt slid, recordedAt kept', readRec(dir).usedAt === iso(at(2 * HOUR)) && readRec(dir).recordedAt === iso(T0));

  // the slide keeps a long working stretch alive past 8h since the first answer
  const r2 = run(['check', '--repo', dir, '--others', '9,4'], { cwd: '/', now: at(9 * HOUR) });
  ok('slide: 9h after record but 7h after last use still reuses', r2.lines[0].status === 'reuse');

  const r3 = run(['check', '--repo', dir, '--others', '4'], { cwd: '/', now: at(9 * HOUR) });
  ok('check claims-changed', r3.lines[0].status === 'ask' && r3.lines[0].reason === 'claims-changed');
  ok('check ask does not touch usedAt', readRec(dir).usedAt === iso(at(9 * HOUR)));
  const r4 = run(['check', '--repo', dir, '--others', 'unavailable'], { cwd: '/', now: at(9 * HOUR) });
  ok('check unavailable', r4.lines[0].status === 'ask' && r4.lines[0].reason === 'unavailable');
  const r5 = run(['check', '--repo', dir, '--others', '4,9'], { cwd: '/', now: at(9 * HOUR + 8 * HOUR + 1) });
  ok('check expired', r5.lines[0].status === 'ask' && r5.lines[0].reason === 'expired');

  // a new answer replaces the previous record
  run(['record', '--repo', dir, '--answer', 'yes', '--others', 'none'], { cwd: '/', now: at(20 * HOUR) });
  ok('record replaces', readRec(dir).answer === 'yes' && readRec(dir).others.length === 0 && readRec(dir).recordedAt === iso(at(20 * HOUR)));

  // clear
  const c = run(['clear', '--repo', dir], { cwd: '/' });
  ok('clear present: cleared, gone', c.code === 0 && c.lines[0].status === 'cleared' && !fs.existsSync(recPath(dir)));
  ok('clear absent', run(['clear', '--repo', dir], { cwd: '/' }).lines[0].status === 'absent');
}

// --- main: --repo defaults to cwd; corrupt file ------------------------------
{
  const dir = mktmp();
  run(['record', '--answer', 'yes', '--others', 'none'], { cwd: dir });
  ok('repo defaults to cwd', readRec(dir).answer === 'yes');
  fs.writeFileSync(recPath(dir), '{not json');
  const r = run(['check', '--others', 'none'], { cwd: dir });
  ok('corrupt file: ask invalid, exit 0', r.code === 0 && r.lines[0].reason === 'invalid');
  fs.writeFileSync(recPath(dir), JSON.stringify(rec({ answer: 'nope' })));
  ok('bad answer in file: invalid', run(['check', '--others', 'none'], { cwd: dir }).lines[0].reason === 'invalid');
}

// --- main: linked worktree resolves to the main checkout's record -----------
{
  const main_ = mktmp();
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(main_, 'init', '-q');
  fs.writeFileSync(path.join(main_, 'f'), 'x');
  git(main_, 'add', 'f');
  git(main_, 'commit', '-q', '-m', 'init');
  const wt = path.join(mktmp(), 'wt');
  git(main_, 'worktree', 'add', '-q', '-b', 'trailhead/t1', wt);
  ok('resolveProjectRoot: main checkout is itself', fs.realpathSync(resolveProjectRoot(main_)) === main_);
  ok('resolveProjectRoot: worktree -> main checkout', fs.realpathSync(resolveProjectRoot(wt)) === main_);
  const sub = path.join(main_, 'sub');
  fs.mkdirSync(sub);
  ok('resolveProjectRoot: subdir of main stays a dir of the same checkout', fs.realpathSync(resolveProjectRoot(sub)) === main_ || resolveProjectRoot(sub) === sub);

  run(['record', '--repo', main_, '--answer', 'no', '--others', 'none'], { cwd: '/' });
  const r = run(['check', '--repo', wt, '--others', 'none'], { cwd: '/', now: at(HOUR) });
  ok('worktree call reads main record', r.lines[0].status === 'reuse' && fs.realpathSync(path.dirname(path.dirname(r.lines[0].path))) === main_);
  ok('worktree gets no record of its own', !fs.existsSync(path.join(wt, '.trailhead', 'isolation-answer.json')));
  run(['record', '--repo', wt, '--answer', 'yes', '--others', '2'], { cwd: '/', now: at(2 * HOUR) });
  ok('worktree record lands in main', readRec(main_).answer === 'yes' && !fs.existsSync(path.join(wt, '.trailhead')));
}

// --- main: not a git repo uses --repo as given ------------------------------
{
  const dir = mktmp();
  ok('resolveProjectRoot: not a git repo -> as given', resolveProjectRoot(dir) === dir);
  ok('resolveProjectRoot: missing dir -> as given', resolveProjectRoot(path.join(dir, 'nope')) === path.join(dir, 'nope'));
}

// --- usage errors: exit 2, nothing written ----------------------------------
for (const argv of [
  ['check', '--others', 'x'],
  ['check'],
  ['record', '--answer', 'maybe', '--others', 'none'],
  ['record', '--answer', 'yes', '--others', 'unavailable'],
  ['record', '--answer', 'yes'],
  ['clear', '--bogus', 'x'],
  ['frobnicate'],
  [],
]) {
  const dir = mktmp();
  const withRepo = argv.length ? [argv[0], '--repo', dir, ...argv.slice(1)] : [];
  const r = run(withRepo, { cwd: dir });
  ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2);
  ok(`usage error writes stderr: ${argv.join(' ')}`, r.err.length > 0);
  ok(`usage error writes nothing: ${argv.join(' ')}`, !fs.existsSync(path.join(dir, '.trailhead')));
}

// --- fault injection ---------------------------------------------------------
for (const failing of ['writeFileSync', 'renameSync']) {
  const dir = mktmp();
  run(['record', '--repo', dir, '--answer', 'no', '--others', 'none'], { cwd: '/' });
  const bytes = fs.readFileSync(recPath(dir));
  const broken = { ...fs, [failing]: () => { throw new Error('boom ' + failing); } };
  if (failing === 'writeFileSync') broken.writeFileSync = () => { throw new Error('boom writeFileSync'); };

  const w = run(['record', '--repo', dir, '--answer', 'yes', '--others', '3'], { cwd: '/', fsMod: broken });
  ok(`record ${failing}: exit 0, skipped with message`, w.code === 0 && w.lines[0].status === 'skipped' && /boom/.test(w.lines[0].message));
  ok(`record ${failing}: previous file byte-identical`, Buffer.compare(fs.readFileSync(recPath(dir)), bytes) === 0);
  ok(`record ${failing}: no temp left`, JSON.stringify(trailheadFiles(dir)) === JSON.stringify(['isolation-answer.json']));

  // a failing refresh on an otherwise valid reuse must never print reuse
  const c = run(['check', '--repo', dir, '--others', 'none'], { cwd: '/', now: at(HOUR), fsMod: broken });
  ok(`check ${failing}: exit 0, skipped not reuse`, c.code === 0 && c.lines.length === 1 && c.lines[0].status === 'skipped' && /boom/.test(c.lines[0].message));
  ok(`check ${failing}: record untouched`, Buffer.compare(fs.readFileSync(recPath(dir)), bytes) === 0);
}
{
  const dir = mktmp();
  run(['record', '--repo', dir, '--answer', 'no', '--others', 'none'], { cwd: '/' });
  const broken = { ...fs, readFileSync: () => { throw Object.assign(new Error('EACCES boom'), { code: 'EACCES' }); } };
  const c = run(['check', '--repo', dir, '--others', 'none'], { cwd: '/', fsMod: broken });
  ok('check unreadable: exit 0, skipped', c.code === 0 && c.lines[0].status === 'skipped' && /boom/.test(c.lines[0].message));
}

// --- end-to-end --------------------------------------------------------------
{
  const dir = mktmp();
  const out = execFileSync('node', [scriptPath, 'record', '--repo', dir, '--answer', 'yes', '--others', '7'], { encoding: 'utf8' });
  ok('e2e: record one JSON line', JSON.parse(out.trim()).status === 'written');
  const chk = execFileSync('node', [scriptPath, 'check', '--repo', dir, '--others', '7'], { encoding: 'utf8' });
  ok('e2e: check reuse', JSON.parse(chk.trim()).status === 'reuse' && JSON.parse(chk.trim()).answer === 'yes');
  const chg = execFileSync('node', [scriptPath, 'check', '--repo', dir, '--others', 'none'], { encoding: 'utf8' });
  ok('e2e: check claims-changed', JSON.parse(chg.trim()).reason === 'claims-changed');
  const bad = spawnSync('node', [scriptPath, 'check', '--repo', dir, '--others', 'nope'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', bad.status === 2);
}

console.log(`isolation-answer.test.js: ${passed} checks passed`);
