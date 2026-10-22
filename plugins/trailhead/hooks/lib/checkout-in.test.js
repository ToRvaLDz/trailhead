#!/usr/bin/env node
// Tests for templates/trailhead-checkout-in.js. Run: node checkout-in.test.js
// No framework: plain asserts, same style as uat-backfill.test.js.
//
// Layers covered:
//   1. The pure token helpers: encode / split / decode round-trip.
//   2. The CLI against real temp git repos: invalid, here, move, the `cd` field.
//   3. The protocol contract: the work skill moves before it loads or preflights.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-checkout-in.js');
const skillPath = path.resolve(__dirname, '..', '..', 'skills', 'trailhead-work', 'SKILL.md');
const { encodeIn, splitIn, decodeIn } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name); passed++; };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-in-')));
const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return fs.realpathSync(dir);
}
const run = (inArg, cwd) => {
  const r = spawnSync(process.execPath, [scriptPath, '--in', inArg, '--cwd', cwd], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null, err: r.stderr };
};
const tokenOf = (p) => encodeIn(p).slice('--in='.length);

// --- 1. pure helpers ---------------------------------------------------------------
const odd = [
  '/tmp/with space/repo',
  "/tmp/it's/repo",
  '/tmp/"dq"/repo',
  '/tmp/-leading/repo',
  '-dash-first',
  '/tmp/uniè中文/repo',
  "/tmp/a'b'c d/$HOME/`x`",
];
for (const p of odd) {
  const enc = encodeIn(p);
  ok(`token shape ${p}`, /^--in=[A-Za-z0-9_-]+$/.test(enc));
  eq(`round-trip ${p}`, decodeIn(enc.slice(5)), p);
}
eq('split takes the last word', splitIn('209 --in=abc_-'), { rest: '209', token: 'abc_-' });
eq('split with no token', splitIn('209'), { rest: '209', token: null });
eq('split ignores a non-final token', splitIn('--in=abc 209'), { rest: '--in=abc 209', token: null });
eq('split ignores a malformed token', splitIn('209 --in=a+b'), { rest: '209 --in=a+b', token: null });
eq('split ignores an empty token', splitIn('209 --in='), { rest: '209 --in=', token: null });
eq('split trims trailing blanks', splitIn('209 --in=abc  '), { rest: '209', token: 'abc' });
eq('decode of garbage', decodeIn('!!!'), null);
eq('decode of empty', decodeIn(''), null);

// --- 2. CLI ------------------------------------------------------------------------
const main = makeRepo(path.join(tmp, 'main repo'));
const other = makeRepo(path.join(tmp, 'other'));
const plain = path.join(tmp, 'plain');
fs.mkdirSync(plain);

{
  const r = run(tokenOf(main), main);
  eq('here in the root', [r.code, r.out.status, r.out.path], [0, 'here', main]);
}
{
  fs.mkdirSync(path.join(main, 'sub'));
  const r = run(tokenOf(main), path.join(main, 'sub'));
  eq('here from a subdir of the same checkout', r.out.status, 'here');
}
{
  const r = run(tokenOf(main), other);
  eq('move from another repo', [r.code, r.out.status, r.out.path], [0, 'move', main]);
  ok('move carries a cd', r.out.cd === `cd -- '${main}'`);
}
{
  const r = run(tokenOf(main), plain);
  eq('move from outside any repo', r.out.status, 'move');
}
{
  const r = run(tokenOf(main), path.join(tmp, 'missing-cwd'));
  eq('move from a cwd that does not exist', r.out.status, 'move');
}

// A worktree root is its own checkout: here only for itself.
{
  const wt = path.join(tmp, 'wt');
  sh(main, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  const wtReal = fs.realpathSync(wt);
  eq('worktree root is here for itself', run(tokenOf(wtReal), wtReal).out.status, 'here');
  eq('worktree root is move from the main checkout', run(tokenOf(wtReal), main).out.status, 'move');
  eq('main checkout is move from the worktree', run(tokenOf(main), wtReal).out.status, 'move');
}

// A symlinked path compares canonical.
{
  const link = path.join(tmp, 'link-to-main');
  fs.symlinkSync(main, link);
  const r = run(tokenOf(link), main);
  eq('symlinked path is here by canonical compare', r.out.status, 'here');
  eq('symlinked cwd is here too', run(tokenOf(main), link).out.status, 'here');
}

// invalid: never searches for another checkout.
{
  eq('relative path is invalid', run(tokenOf('relative/dir'), main).out.status, 'invalid');
  eq('missing path is invalid', run(tokenOf(path.join(tmp, 'nope')), main).out.status, 'invalid');
  eq('non-repo dir is invalid', run(tokenOf(plain), main).out.status, 'invalid');
  eq('subdir of a repo is invalid (not a root)', run(tokenOf(path.join(main, 'sub')), other).out.status, 'invalid');
  const bad = run('!!!', main);
  eq('undecodable token is invalid', [bad.code, bad.out.status], [0, 'invalid']);
  ok('invalid has a reason', typeof bad.out.reason === 'string' && bad.out.reason.length > 0);
  ok('invalid has no cd', !('cd' in run(tokenOf(plain), main).out));
}

// usage errors
{
  const r = spawnSync(process.execPath, [scriptPath, '--cwd', main], { encoding: 'utf8' });
  eq('missing --in is a usage error', r.status, 2);
  const r2 = spawnSync(process.execPath, [scriptPath, '--in', tokenOf(main)], { encoding: 'utf8' });
  eq('missing --cwd is a usage error', r2.status, 2);
}

// The cd field, run by a shell, lands in the path for every pathological case.
{
  let n = 0;
  for (const p of odd) {
    if (!path.isAbsolute(p)) continue;
    const dir = path.join(tmp, `odd${n++}`, p.replace(/^\/tmp\//, '').replace(/\//g, '_'));
    const real = makeRepo(dir);
    const r = run(tokenOf(real), plain);
    eq(`move for ${dir}`, r.out.status, 'move');
    const cd = spawnSync('sh', ['-c', `${r.out.cd} && pwd -P`], { encoding: 'utf8', cwd: plain });
    eq(`cd lands in ${dir}`, cd.stdout.trim(), real);
  }
  // A quote and a leading dash in the actual directory names.
  for (const name of ["it's here", '-dash', 'sp ace "dq" $x `y`']) {
    const real = makeRepo(path.join(tmp, 'pathological', name));
    const r = run(tokenOf(real), plain);
    const cd = spawnSync('sh', ['-c', `${r.out.cd} && pwd -P`], { encoding: 'utf8', cwd: plain });
    eq(`cd lands in ${name}`, cd.stdout.trim(), real);
  }
}

// --- 3. protocol contract: the move comes before anything else -----------------------
{
  const skill = fs.readFileSync(skillPath, 'utf8');
  const move = skill.indexOf('## Move into the handed checkout');
  ok('move section exists', move >= 0);
  const load = skill.indexOf('## Load first');
  const pre = skill.indexOf('## Preflight');
  ok('move section sits before Load first', load > move);
  ok('move section sits before the Preflight', pre > move);
  const section = skill.slice(move, load);
  ok('names the helper', section.includes('trailhead-checkout-in.js'));
  ok('names the --in= word', section.includes('--in='));
  ok('names work and resume', /`work`/.test(section) && /`resume`/.test(section));
  ok('runs the cd field verbatim', /`cd` field[^.]*verbatim/.test(section));
  ok('cd is its own Bash call', /own Bash call/.test(section));
  ok('post-move re-check requires here', /re-run the helper/.test(section) && /`here`/.test(section));
  ok('stops on invalid', /`invalid`[^.]*stop/.test(section));
  ok('stops on a failed cd', /failed `cd`[^.]*stop|`cd` fails[^.]*stop|stop[^.]*`cd` fail/i.test(section));
  ok('stops when the post-check is not here', /could not move/.test(section));
  ok('stops when the helper is missing', /missing[^.]*stop|stop[^.]*missing/i.test(section));
  ok('never moves by hand', /by hand/.test(section));
  ok('Routing points at the move section', /Routing[\s\S]*Move into the handed checkout/.test(skill.slice(skill.indexOf('## Routing'))));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`checkout-in: ${passed} assertions passed`);
