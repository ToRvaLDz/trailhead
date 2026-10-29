#!/usr/bin/env node
// Tests for templates/trailhead-checkout-find.js. Run: node checkout-find.test.js
// No framework: plain asserts, same style as checkout-in.test.js.
//
// Layers covered:
//   1. parseRemote / matches: pure URL handling.
//   2. findCheckouts over temp roots: matching, walk rules, truncation, tiers.
//   3. The CLI: statuses, default tiers under a temp HOME, usage errors.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-checkout-find.js');

// require() must print nothing and must not exit.
const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(scriptPath)}); process.stdout.write('alive')`], { encoding: 'utf8' });
assert.strictEqual(probe.stdout, 'alive', 'require prints nothing and does not exit');
const { parseRemote, parseRepoShape, matches, findCheckouts } = require(scriptPath);

let passed = 1;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name); passed++; };

// --- 1. pure helpers ---------------------------------------------------------------
const GH = { host: 'github.com', path: 'o/r' };
for (const u of [
  'https://github.com/o/r.git', 'https://github.com/o/r', 'https://github.com/o/r/', 'ssh://git@github.com/o/r.git',
  'git@github.com:o/r.git', 'git@github.com:o/r', 'github.com:o/r', 'https://user@GitHub.com/o/r.git', 'git://github.com/o/r.git',
  '  git@github.com:o/r.git\n',
]) eq(`parse ${u.trim()}`, parseRemote(u), GH);
eq('port kept in the host', parseRemote('ssh://git@ghe.example.com:2222/o/r.git'), { host: 'ghe.example.com:2222', path: 'o/r' });
eq('nested group path', parseRemote('git@gitlab.com:g/sub/r.git'), { host: 'gitlab.com', path: 'g/sub/r' });
eq('local path is not a remote', parseRemote('/srv/git/r.git'), null);
eq('relative path is not a remote', parseRemote('../r'), null);
eq('empty is not a remote', parseRemote(''), null);

ok('github path is case-insensitive', matches('git@github.com:Foo/Bar.git', 'github.com/foo/bar'));
ok('host is case-insensitive', matches('https://GITHUB.com/o/r', 'github.com/o/r'));
ok('bare owner/name matches any host', matches('git@gitlab.com:o/r.git', 'o/r'));
ok('host mismatch rejects', !matches('git@gitlab.com:o/r.git', 'github.com/o/r'));
ok('path case is exact off github', !matches('https://gitlab.com/O/r', 'gitlab.com/o/r') && matches('https://gitlab.com/o/r', 'gitlab.com/o/r'));
ok('different repo rejects', !matches('https://github.com/o/other', 'github.com/o/r'));
ok('wanted port must equal the remote port', matches('ssh://git@h.io:2222/o/r', 'h.io:2222/o/r') && !matches('ssh://git@h.io:2223/o/r', 'h.io:2222/o/r'));
ok('port-less wanted host ignores the remote port', matches('ssh://git@h.io:2222/o/r', 'h.io/o/r'));
eq('repo shape: a dotless host is a host', parseRepoShape('gitea/owner/name'), { host: 'gitea', path: 'owner/name' });
eq('repo shape: two segments is no shape', parseRepoShape('owner/name'), null);
ok('a parsed dotless host matches a scp remote', matches('git@gitea:owner/name.git', { host: 'gitea', path: 'owner/name' }));
ok('a parsed dotless host rejects another host', !matches('git@forge:owner/name.git', { host: 'gitea', path: 'owner/name' }));
ok('nested group matches', matches('git@gitlab.com:g/sub/r.git', 'gitlab.com/g/sub/r'));

// --- 2. findCheckouts --------------------------------------------------------------
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-find-')));
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
function makeRepo(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return fs.realpathSync(dir);
}
const fresh = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return fs.realpathSync(d); };
const WANT = 'github.com/o/r';

{
  const root = fresh('basic');
  const a = makeRepo(path.join(root, 'a'), 'git@github.com:O/R.git');
  makeRepo(path.join(root, 'b'), 'https://github.com/o/other');
  makeRepo(path.join(root, 'c'), null);
  eq('lone match is found (case, .git, scp)', findCheckouts(WANT, { roots: [root] }), { status: 'found', path: a });
  const https = makeRepo(path.join(root, 'deep', 'd'), 'https://github.com/o/r');
  const r = findCheckouts(WANT, { roots: [root] });
  eq('ssh and https both match: ambiguous, sorted', r, { status: 'ambiguous', candidates: [{ path: a, kind: 'main' }, { path: https, kind: 'main' }] });
  eq('no match is none with the searched roots', findCheckouts('github.com/x/y', { roots: [root] }), { status: 'none', searched: [root] });
}
{
  const root = fresh('nested');
  const outer = makeRepo(path.join(root, 'outer'), 'https://github.com/o/other');
  makeRepo(path.join(outer, 'inner'), 'https://github.com/o/r');
  eq('a nested repo under a checkout is not descended', findCheckouts(WANT, { roots: [root] }).status, 'none');
}
{
  const root = fresh('worktrees');
  const main = makeRepo(path.join(root, 'main'), 'https://github.com/o/r');
  git(main, 'worktree', 'add', '-q', '-b', 'wt', path.join(root, 'wt'));
  const wt = fs.realpathSync(path.join(root, 'wt'));
  eq('main + worktree is ambiguous with kinds', findCheckouts(WANT, { roots: [root] }),
    { status: 'ambiguous', candidates: [{ path: main, kind: 'main' }, { path: wt, kind: 'linked' }].sort((x, y) => (x.path < y.path ? -1 : 1)) });
  const lone = fresh('lone-wt');
  const base = makeRepo(path.join(tmp, 'elsewhere-main'), 'https://github.com/o/r');
  git(base, 'worktree', 'add', '-q', '-b', 'wt2', path.join(lone, 'wt'));
  eq('a lone worktree is found', findCheckouts(WANT, { roots: [lone] }), { status: 'found', path: fs.realpathSync(path.join(lone, 'wt')) });
}
{
  const root = fresh('overlap');
  const a = makeRepo(path.join(root, 'sub', 'a'), 'https://github.com/o/r');
  eq('overlapping roots never double-count', findCheckouts(WANT, { roots: [root, path.join(root, 'sub'), root] }), { status: 'found', path: a });
  fs.symlinkSync(root, path.join(root, 'sub', 'loop'));
  fs.symlinkSync(path.join(root, 'sub', 'a'), path.join(root, 'alias'));
  eq('a symlink cycle and an alias never double-count', findCheckouts(WANT, { roots: [root] }), { status: 'found', path: a });
}
{
  const root = fresh('skips');
  makeRepo(path.join(root, 'node_modules', 'pkg'), 'https://github.com/o/r');
  makeRepo(path.join(root, '.hidden', 'x'), 'https://github.com/o/r');
  eq('node_modules and dot-dirs are skipped', findCheckouts(WANT, { roots: [root] }).status, 'none');
}
{
  const root = fresh('depth');
  const deep = makeRepo(path.join(root, 'l1', 'l2', 'l3', 'r'), 'https://github.com/o/r');
  eq('depth 3 reaches the 3rd level below the root', findCheckouts(WANT, { roots: [root], depth: 3 }).status, 'none');
  eq('depth 4 reaches the 4th level', findCheckouts(WANT, { roots: [root], depth: 4 }), { status: 'found', path: deep });
  const near = makeRepo(path.join(root, 'n1', 'n2', 'n3'), 'https://github.com/o/r');
  eq('default depth 3 reaches level 3', findCheckouts(WANT, { roots: [root] }), { status: 'found', path: near });
}
{
  const root = fresh('nested-group');
  const g = makeRepo(path.join(root, 'g'), 'git@gitlab.com:grp/sub/repo.git');
  eq('a nested group/sub/repo remote is found', findCheckouts('gitlab.com/grp/sub/repo', { roots: [root] }), { status: 'found', path: g });
  const p = makeRepo(path.join(root, 'p'), 'ssh://git@ghe.io:2222/o/r.git');
  eq('port kept: wanted with the port matches', findCheckouts('ghe.io:2222/o/r', { roots: [root] }), { status: 'found', path: p });
  eq('port kept: another port does not', findCheckouts('ghe.io:2223/o/r', { roots: [root] }).status, 'none');
  eq('path case exact off github', findCheckouts('gitlab.com/GRP/sub/repo', { roots: [root] }).status, 'none');
}
{
  const root = fresh('broken');
  const a = makeRepo(path.join(root, 'ok'), 'https://github.com/o/r');
  const bad = makeRepo(path.join(root, 'bad'), 'https://github.com/o/r');
  fs.writeFileSync(path.join(bad, '.git', 'config'), '[remote "origin"\n\turl = ???\n');
  eq('a broken config is skipped', findCheckouts(WANT, { roots: [root] }), { status: 'found', path: a });
  eq('a checkout with no origin is skipped', findCheckouts(WANT, { roots: [fresh('noorigin')] }).status, 'none');
}
{
  // Cap: injected origin reader keeps it deterministic.
  const root = fresh('cap');
  for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(root, `d${i}`));
  const hit = makeRepo(path.join(root, 'a-hit'), 'https://github.com/o/r');
  const originOf = (dir) => (dir === hit ? 'https://github.com/o/r' : null);
  eq('no cap hit: found', findCheckouts(WANT, { roots: [root], originOf }), { status: 'found', path: hit });
  eq('cap hit with a lone match is ambiguous and truncated', findCheckouts(WANT, { roots: [root], originOf, cap: 3 }),
    { status: 'ambiguous', candidates: [{ path: hit, kind: 'main' }], truncated: true });
  eq('cap hit with no match is none and truncated', findCheckouts('github.com/x/y', { roots: [root], originOf, cap: 2 }),
    { status: 'none', searched: [root], truncated: true });
}
{
  const focused = fresh('tier-focused');
  const home = fresh('tier-home');
  const f = makeRepo(path.join(focused, 'f'), 'https://github.com/o/r');
  makeRepo(path.join(home, 'h'), 'https://github.com/o/r');
  eq('a focused-tier match wins over a home-tier one', findCheckouts(WANT, { tiers: [[focused], [home]] }), { status: 'found', path: f });
  const empty = fresh('tier-empty');
  const h2 = makeRepo(path.join(home, 'only-home'), 'https://github.com/o/solo');
  eq('home tier is searched when the focused one is empty', findCheckouts('github.com/o/solo', { tiers: [[empty], [home]] }), { status: 'found', path: h2 });
  eq('a cap on the focused tier does not starve the home tier', findCheckouts('github.com/o/solo', { tiers: [[focused], [home]], cap: 3 }).status, 'found');
}

// --- 3. CLI ------------------------------------------------------------------------
const cli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null, err: r.stderr };
};
{
  const root = fresh('cli');
  const a = makeRepo(path.join(root, 'a'), 'https://github.com/o/r');
  eq('cli found', cli(['--repo', WANT, '--roots', root]).out, { status: 'found', path: a });
  const b = makeRepo(path.join(root, 'b'), 'git@github.com:o/r.git');
  const amb = cli(['--repo', 'o/r', '--roots', root]);
  eq('cli ambiguous (bare owner/name)', [amb.code, amb.out.status, amb.out.candidates.map((c) => c.path)], [0, 'ambiguous', [a, b]]);
  eq('cli none', cli(['--repo', 'github.com/x/y', '--roots', root]).out, { status: 'none', searched: [root] });
  eq('cli depth 0 sees only the roots', cli(['--repo', WANT, '--roots', root, '--depth', '0']).out.status, 'none');

  // Default tiers under a temp HOME: a code folder wins, then $HOME itself.
  const home = fresh('cli-home');
  const inGit = makeRepo(path.join(home, 'Git', 'proj'), 'https://github.com/o/r');
  makeRepo(path.join(home, 'stray', 'proj'), 'https://github.com/o/r');
  const cwd = path.join(fresh('cli-cwd-parent'), 'cwd');
  fs.mkdirSync(cwd);
  eq('default tiers: the focused code folder wins', cli(['--repo', WANT, '--cwd', cwd], { HOME: home }).out, { status: 'found', path: inGit });
  const home2 = fresh('cli-home2');
  const stray = makeRepo(path.join(home2, 'stray', 'proj'), 'https://github.com/o/r');
  eq('default tiers: falls back to $HOME', cli(['--repo', WANT, '--cwd', cwd], { HOME: home2 }).out, { status: 'found', path: stray });
}
{
  const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  eq('missing --repo is a usage error', r.status, 2);
  eq('a repo with no owner is a usage error', spawnSync(process.execPath, [scriptPath, '--repo', 'solo'], { encoding: 'utf8' }).status, 2);
  eq('a bad --depth is a usage error', spawnSync(process.execPath, [scriptPath, '--repo', WANT, '--depth', 'x'], { encoding: 'utf8' }).status, 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`checkout-find: ${passed} assertions passed`);
