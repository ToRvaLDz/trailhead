#!/usr/bin/env node
// Tests for templates/trailhead-repo-target.js (#351). Run: node repo-target.test.js
// No framework: plain asserts, same style as isolation-answer.test.js.
// The gh/git runner is always injected: no test calls the real gh or writes to GitHub.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-repo-target.js');
const { parseGithubSlug, parentSlug, decide, parseArgs, main, IDLE_WINDOW_MS, SLUG_RE } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const HOUR = 3600 * 1000;
const T0 = new Date('2026-10-14T08:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms);
const iso = (d) => d.toISOString();
const mktmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-repo-target-test-')));

// Fake runner. world: { view, originView, remotes, setDefault } ; records every call.
function fakeRun(world) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const fail = { status: 1, stdout: '', stderr: 'boom' };
    if (cmd === 'git') {
      return world.remotes === undefined ? fail
        : { status: 0, stdout: world.remotes.map(([n, u]) => `remote.${n}.url ${u}`).join('\n') + '\n', stderr: '' };
    }
    if (args[0] === 'repo' && args[1] === 'set-default') return world.setDefault || { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'repo' && args[1] === 'view') {
      const v = args.includes('--') ? world.originView : world.view;
      return v ? { status: 0, stdout: JSON.stringify(v), stderr: '' } : fail;
    }
    return fail;
  };
  return { run, calls };
}

function runMain(argv, { cwd, now = T0, world }) {
  const chunks = [];
  const { run, calls } = fakeRun(world || {});
  const realErr = process.stderr.write.bind(process.stderr);
  const errChunks = [];
  process.stderr.write = (s) => { errChunks.push(String(s)); return true; };
  let code;
  try {
    code = main(argv, { cwd, now, run, stdout: { write: (s) => chunks.push(s) } });
  } finally {
    process.stderr.write = realErr;
  }
  return { code, lines: chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)), calls, err: errChunks.join('') };
}

const recPath = (dir) => path.join(dir, '.trailhead', 'repo-target.json');
const writeRec = (dir, over = {}) => {
  fs.mkdirSync(path.join(dir, '.trailhead'), { recursive: true });
  fs.writeFileSync(recPath(dir), JSON.stringify({ target: 'cli/cli', recordedAt: iso(T0), usedAt: iso(T0), ...over }));
};
const forkWorld = (over = {}) => ({
  view: { nameWithOwner: 'cli/cli', viewerPermission: 'READ' },
  remotes: [['origin', 'https://github.com/fakeuser/cli.git'], ['upstream', 'git@github.com:cli/cli.git']],
  originView: { nameWithOwner: 'fakeuser/cli', isFork: true, parent: { name: 'cli', owner: { login: 'cli' } } },
  ...over,
});

// --- URL parsing ---------------------------------------------------------------
ok('slug https', parseGithubSlug('https://github.com/o/n.git') === 'o/n');
ok('slug https no .git', parseGithubSlug('https://github.com/o/n') === 'o/n');
ok('slug https with token user', parseGithubSlug('https://x-access-token:abc@github.com/o/n.git') === 'o/n');
ok('slug scp ssh', parseGithubSlug('git@github.com:o/n.git') === 'o/n');
ok('slug ssh://', parseGithubSlug('ssh://git@github.com/o/n.git') === 'o/n');
ok('slug ssh:// with port', parseGithubSlug('ssh://git@github.com:22/o/n') === 'o/n');
ok('slug dotted name', parseGithubSlug('git@github.com:o/n.js.git') === 'o/n.js');
for (const bad of ['https://gitlab.com/o/n.git', 'git@gitlab.com:o/n.git', '/local/path', '', null, undefined, 'https://github.com/only']) {
  ok(`slug non-GitHub/invalid -> null: ${bad}`, parseGithubSlug(bad) === null);
}
ok('parentSlug owner.login', parentSlug({ name: 'cli', owner: { login: 'cli' } }) === 'cli/cli');
ok('parentSlug nameWithOwner', parentSlug({ nameWithOwner: 'a/b' }) === 'a/b');
ok('parentSlug null', parentSlug(null) === null);

// --- decide (pure) -------------------------------------------------------------
{
  ok('window is 8 hours', IDLE_WINDOW_MS === 8 * HOUR);
  const f = (o = {}) => ({ target: 'o/n', permission: 'WRITE', originSlug: 'o/n', originInfo: null, remotes: ['o/n'], ...o });
  const rec = (o = {}) => ({ target: 'o/n', recordedAt: iso(T0), usedAt: iso(T0), ...o });
  ok('plain repo -> ok', decide(f(), null, T0).status === 'ok');
  for (const p of ['ADMIN', 'MAINTAIN', 'WRITE']) ok(`permission ${p} -> ok`, decide(f({ permission: p }), null, T0).status === 'ok');
  ok('unknown permission -> ok', decide(f({ permission: undefined }), null, T0).status === 'ok');
  const fork = f({ target: 'cli/cli', originSlug: 'u/cli', originInfo: { isFork: true, parent: { name: 'cli', owner: { login: 'cli' } } }, remotes: ['u/cli', 'cli/cli'] });
  const d = decide(fork, null, T0);
  ok('fork with parent resolved -> ask fork-parent', d.status === 'ask' && d.reason === 'fork-parent');
  ok('fork-parent candidates: fork then parent', JSON.stringify(d.candidates) === '["u/cli","cli/cli"]');
  ok('fork-parent is case-insensitive', decide({ ...fork, target: 'CLI/cli' }, null, T0).reason === 'fork-parent');
  const own = f({ target: 'u/cli', originSlug: 'u/cli', originInfo: null });
  ok('fork whose target is itself -> ok', decide(own, null, T0).status === 'ok');
  ok('origin not a fork of target -> ok', decide(f({ target: 'x/y', originSlug: 'u/cli', originInfo: { isFork: true, parent: { name: 'cli', owner: { login: 'cli' } } } }), null, T0).status === 'ok');
  ok('origin not a fork -> ok', decide(f({ target: 'x/y', originSlug: 'u/cli', originInfo: { isFork: false, parent: null } }), null, T0).status === 'ok');
  // origin that cannot be verified -> skipped, never a silent ok (#351 I1)
  const unv = decide(f({ target: 'x/y', originSlug: 'u/cli', originInfo: null, originExists: true }), null, T0);
  ok('origin differs, lookup failed -> skipped', unv.status === 'skipped' && unv.reason === 'origin fork relation could not be verified');
  const nonGh = decide(f({ target: 'x/y', originSlug: null, originInfo: null, originExists: true }), null, T0);
  ok('origin not a github.com URL -> skipped', nonGh.status === 'skipped' && nonGh.reason === 'origin fork relation could not be verified');
  ok('no origin remote at all -> ok', decide(f({ originSlug: null, originExists: false }), null, T0).status === 'ok');
  ok('origin == target, exists -> ok', decide(f({ originExists: true }), null, T0).status === 'ok');
  ok('no-write still asks before the unverified skip', decide(f({ permission: 'READ', target: 'x/y', originSlug: 'u/cli', originInfo: null, originExists: true, remotes: ['u/cli', 'x/y'] }), null, T0).reason === 'no-write');
  const nw = decide(f({ permission: 'READ', target: 'x/y', originSlug: 'u/cli', remotes: ['u/cli', 'x/y'] }), null, T0);
  ok('no write -> ask no-write', nw.status === 'ask' && nw.reason === 'no-write');
  ok('no-write candidates: origin first, target included', JSON.stringify(nw.candidates) === '["u/cli","x/y"]');
  ok('no-write with only the target remote', JSON.stringify(decide(f({ permission: 'NONE' }), null, T0).candidates) === '["o/n"]');
  ok('fork-parent wins over no-write', decide({ ...fork, permission: 'READ' }, null, T0).reason === 'fork-parent');
  // recorded answer
  ok('record same target in window -> reuse', decide(fork, rec({ target: 'cli/cli' }), T0).status === 'reuse');
  ok('reuse carries recordedAt', decide(fork, rec({ target: 'cli/cli' }), T0).recordedAt === iso(T0));
  ok('reuse is case-insensitive', decide(fork, rec({ target: 'CLI/CLI' }), T0).status === 'reuse');
  ok('exactly 8h reuses', decide(fork, rec({ target: 'cli/cli' }), at(8 * HOUR)).status === 'reuse');
  ok('over 8h -> re-check', decide(fork, rec({ target: 'cli/cli' }), at(8 * HOUR + 1)).status === 'ask');
  ok('target changed -> re-check', decide(fork, rec({ target: 'other/repo' }), T0).status === 'ask');
  for (const [name, r] of [
    ['non-object', 'x'], ['array', []], ['bad slug', rec({ target: 'nope' })], ['missing target', { recordedAt: iso(T0), usedAt: iso(T0) }],
    ['malformed usedAt', rec({ target: 'cli/cli', usedAt: 'yesterday' })], ['future usedAt', rec({ target: 'cli/cli', usedAt: iso(at(HOUR)) })],
    ['future recordedAt', rec({ target: 'cli/cli', recordedAt: iso(at(HOUR)) })], ['non-ISO', rec({ target: 'cli/cli', usedAt: '2026' })],
  ]) ok(`invalid record -> re-check: ${name}`, decide(fork, r, T0).status === 'ask');
}

// --- parseArgs -----------------------------------------------------------------
{
  const r = parseArgs(['record', '--repo', '/x', '--target', 'o/n']);
  ok('parseArgs record', r.command === 'record' && r.repo === '/x' && r.target === 'o/n');
  ok('parseArgs check', parseArgs(['check']).command === 'check');
  ok('parseArgs clear', parseArgs(['clear', '--repo', '/x']).repo === '/x');
  for (const bad of ['-x/y', '--exec/y', '.x/y', '_x/y', 'x/', '/y', 'a/b/c', 'x y/z']) ok(`SLUG_RE rejects ${bad}`, !SLUG_RE.test(bad));
  for (const good of ['o/n', 'cli/cli', 'a-b/c.d_e', '0x/y']) ok(`SLUG_RE accepts ${good}`, SLUG_RE.test(good));
  ok('parseArgs rejects a -x/y target', !!parseArgs(['record', '--target', '-x/y']).error);
  for (const argv of [[], ['frob'], ['record'], ['record', '--target', 'nope'], ['record', '--target'], ['check', '--target', 'o/n'], ['clear', '--bogus', '1']]) {
    ok(`parseArgs error: ${argv.join(' ')}`, !!parseArgs(argv).error);
  }
}

// --- main: check ---------------------------------------------------------------
{
  const dir = mktmp();
  const plain = runMain(['check', '--repo', dir], { cwd: '/', world: {
    view: { nameWithOwner: 'o/n', viewerPermission: 'ADMIN' }, remotes: [['origin', 'git@github.com:o/n.git']] } });
  ok('plain repo: exit 0, ok, silent', plain.code === 0 && plain.lines[0].status === 'ok' && plain.lines[0].target === 'o/n');
  ok('plain repo: no origin lookup, nothing written', plain.calls.length === 2 && !fs.existsSync(path.join(dir, '.trailhead')));

  const a = runMain(['check', '--repo', dir], { cwd: '/', world: forkWorld() });
  ok('fork clone, parent resolved: ask fork-parent', a.lines[0].status === 'ask' && a.lines[0].reason === 'fork-parent');
  ok('ask lists both candidates and the path', JSON.stringify(a.lines[0].candidates) === '["fakeuser/cli","cli/cli"]' && a.lines[0].path === recPath(dir));
  ok('ask writes nothing', !fs.existsSync(recPath(dir)));
  ok('ask: only read-only gh calls', a.calls.every((c) => c[0] === 'git' || (c[1] === 'repo' && c[2] !== 'set-default')));

  const own = runMain(['check', '--repo', dir], { cwd: '/', world: forkWorld({
    view: { nameWithOwner: 'fakeuser/cli', viewerPermission: 'ADMIN' } }) });
  ok('fork resolving to itself: ok', own.lines[0].status === 'ok' && own.lines[0].target === 'fakeuser/cli');

  const nw = runMain(['check', '--repo', dir], { cwd: '/', world: {
    view: { nameWithOwner: 'o/n', viewerPermission: 'READ' }, remotes: [['origin', 'https://github.com/o/n.git']] } });
  ok('no write permission: ask no-write', nw.lines[0].status === 'ask' && nw.lines[0].reason === 'no-write');

  // recorded answer
  writeRec(dir, { target: 'cli/cli' });
  const re = runMain(['check', '--repo', dir], { cwd: '/', now: at(2 * HOUR), world: forkWorld() });
  ok('recorded answer: reuse', re.lines[0].status === 'reuse' && re.lines[0].target === 'cli/cli' && re.lines[0].recordedAt === iso(T0));
  ok('reuse slides usedAt, keeps recordedAt', JSON.parse(fs.readFileSync(recPath(dir), 'utf8')).usedAt === iso(at(2 * HOUR))
    && JSON.parse(fs.readFileSync(recPath(dir), 'utf8')).recordedAt === iso(T0));
  ok('slide keeps a long stretch alive', runMain(['check', '--repo', dir], { cwd: '/', now: at(9 * HOUR), world: forkWorld() }).lines[0].status === 'reuse');
  ok('expired record re-checks', runMain(['check', '--repo', dir], { cwd: '/', now: at(30 * HOUR), world: forkWorld() }).lines[0].status === 'ask');
  writeRec(dir, { target: 'someone/else' });
  ok('target changed re-checks', runMain(['check', '--repo', dir], { cwd: '/', world: forkWorld() }).lines[0].status === 'ask');
  fs.writeFileSync(recPath(dir), '{not json');
  ok('corrupt record re-checks', runMain(['check', '--repo', dir], { cwd: '/', world: forkWorld() }).lines[0].status === 'ask');

  // failures never block
  const g = runMain(['check', '--repo', dir], { cwd: '/', world: {} });
  ok('gh failure: skipped, exit 0', g.code === 0 && g.lines[0].status === 'skipped' && g.lines[0].reason.length > 0);
  const nogit = runMain(['check', '--repo', dir], { cwd: '/', world: { view: { nameWithOwner: 'o/n', viewerPermission: 'WRITE' } } });
  ok('no remotes readable: target alone, ok', nogit.lines[0].status === 'ok');
  const noOriginInfo = runMain(['check', '--repo', dir], { cwd: '/', world: forkWorld({ originView: undefined, view: { nameWithOwner: 'cli/cli', viewerPermission: 'WRITE' } }) });
  ok('origin lookup fails: skipped, not a silent ok', noOriginInfo.lines[0].status === 'skipped' && /could not be verified/.test(noOriginInfo.lines[0].reason));
  const ghes = runMain(['check', '--repo', dir], { cwd: '/', world: { view: { nameWithOwner: 'cli/cli', viewerPermission: 'WRITE' }, remotes: [['origin', 'git@ghe.example.com:u/cli.git']] } });
  ok('origin on another host: skipped', ghes.lines[0].status === 'skipped' && /could not be verified/.test(ghes.lines[0].reason));
  ok('origin lookup passes -- before the slug', a.calls.some((c) => c.join(' ') === 'gh repo view --json nameWithOwner,isFork,parent -- fakeuser/cli'));
}

// --- main: record --------------------------------------------------------------
{
  const dir = mktmp();
  const w = runMain(['record', '--repo', dir, '--target', 'fakeuser/cli'], { cwd: '/', world: forkWorld() });
  ok('record differing target: written, setDefault true', w.lines[0].status === 'written' && w.lines[0].setDefault === true && w.lines[0].target === 'fakeuser/cli');
  ok('record calls gh repo set-default with the target', w.calls.some((c) => c.join(' ') === 'gh repo set-default -- fakeuser/cli'));
  const s = JSON.parse(fs.readFileSync(recPath(dir), 'utf8'));
  ok('record file shape', JSON.stringify(Object.keys(s)) === '["target","recordedAt","usedAt"]' && s.target === 'fakeuser/cli' && s.recordedAt === iso(T0));
  ok('record in a non-git dir leaves .gitignore alone', !fs.existsSync(path.join(dir, '.gitignore')));
  ok('record leaves no temp', fs.readdirSync(path.join(dir, '.trailhead')).join() === 'repo-target.json');

  const same = runMain(['record', '--repo', dir, '--target', 'cli/cli'], { cwd: '/', now: at(HOUR), world: forkWorld() });
  ok('record same as current: no set-default', same.lines[0].setDefault === false && !same.calls.some((c) => c.includes('set-default')));
  ok('record replaces the file', JSON.parse(fs.readFileSync(recPath(dir), 'utf8')).target === 'cli/cli');

  const dir2 = mktmp();
  const bad = runMain(['record', '--repo', dir2, '--target', 'fakeuser/cli'], { cwd: '/', world: forkWorld({ setDefault: { status: 1, stdout: '', stderr: 'no such repo\nmore' } }) });
  ok('set-default failure: error with reason, exit 0', bad.code === 0 && bad.lines[0].status === 'error' && /no such repo/.test(bad.lines[0].reason));
  ok('set-default failure: nothing written', !fs.existsSync(path.join(dir2, '.trailhead')));
  const noView = runMain(['record', '--repo', dir2, '--target', 'fakeuser/cli'], { cwd: '/', world: {} });
  ok('record with unresolvable gh: error, nothing written', noView.lines[0].status === 'error' && !fs.existsSync(path.join(dir2, '.trailhead')));
}

// --- main: record keeps the marker gitignored (#351 W1) ---------------------------
{
  const IGN = '.trailhead/repo-target.json';
  const gitDir = mktmp();
  fs.mkdirSync(path.join(gitDir, '.git'));
  const give = () => runMain(['record', '--repo', gitDir, '--target', 'cli/cli'], { cwd: '/', world: forkWorld() });
  give();
  ok('record creates .gitignore with the marker in a git repo', fs.readFileSync(path.join(gitDir, '.gitignore'), 'utf8') === IGN + '\n');
  give();
  ok('record is idempotent on .gitignore', fs.readFileSync(path.join(gitDir, '.gitignore'), 'utf8') === IGN + '\n');
  const g2 = mktmp();
  fs.mkdirSync(path.join(g2, '.git'));
  fs.writeFileSync(path.join(g2, '.gitignore'), 'node_modules');
  runMain(['record', '--repo', g2, '--target', 'cli/cli'], { cwd: '/', world: forkWorld() });
  ok('record appends after a file without trailing newline', fs.readFileSync(path.join(g2, '.gitignore'), 'utf8') === 'node_modules\n' + IGN + '\n');
  const g3 = mktmp();
  fs.mkdirSync(path.join(g3, '.git'));
  runMain(['record', '--repo', g3, '--target', 'fakeuser/cli'], { cwd: '/', world: forkWorld({ setDefault: { status: 1, stdout: '', stderr: 'x' } }) });
  ok('a failed record does not touch .gitignore', !fs.existsSync(path.join(g3, '.gitignore')));
}

// --- main: clear, usage errors -------------------------------------------------
{
  const dir = mktmp();
  writeRec(dir);
  ok('clear present', runMain(['clear', '--repo', dir], { cwd: '/' }).lines[0].status === 'cleared' && !fs.existsSync(recPath(dir)));
  ok('clear absent', runMain(['clear', '--repo', dir], { cwd: '/' }).lines[0].status === 'absent');
  for (const argv of [['record', '--target', 'nope'], ['record'], ['check', '--bogus', 'x'], ['frob'], []]) {
    const d = mktmp();
    const r = runMain(argv.length ? [argv[0], '--repo', d, ...argv.slice(1)] : [], { cwd: d });
    ok(`usage error exit 2: ${argv.join(' ')}`, r.code === 2 && r.err.length > 0 && !fs.existsSync(path.join(d, '.trailhead')));
  }
}

// --- end-to-end (no gh involved: usage error and clear only) -------------------
{
  const dir = mktmp();
  const bad = spawnSync('node', [scriptPath, 'record', '--repo', dir, '--target', 'nope'], { encoding: 'utf8' });
  ok('e2e: usage error exits 2', bad.status === 2);
  const c = spawnSync('node', [scriptPath, 'clear', '--repo', dir], { encoding: 'utf8' });
  ok('e2e: clear absent prints one JSON line', c.status === 0 && JSON.parse(c.stdout.trim()).status === 'absent');
}

console.log(`repo-target.test.js: ${passed} checks passed`);
