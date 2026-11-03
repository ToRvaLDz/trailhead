// Mod side of #349: git spawns go through `env -u <repo-location vars> git ...`
// (the mod's process.run cannot delete env), and the name list matches the template's.
// The mod file is TypeScript: loaded through Node's type stripping (Node >= 22.18);
// skipped on an older Node, where the source checks below still run.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GIT_LOCATION_VARS } = require('../../templates/trailhead-git-env.js');

const modDir = path.join(__dirname, '..', 'mod');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

let mod = null;
try { mod = require(path.join(modDir, 'git-env.ts')); } catch { /* no type stripping */ }

if (mod) {
  t('the mod name list equals the template list', () => {
    assert.deepStrictEqual([...mod.GIT_LOCATION_VARS], [...GIT_LOCATION_VARS]);
  });
  t('gitArgv starts with the env -u wrapper and ends with git args', () => {
    const argv = mod.gitArgv('-C', '/r', 'status');
    const gitAt = argv.indexOf('git');
    assert.strictEqual(argv[0], 'env');
    assert.deepStrictEqual(argv.slice(gitAt), ['git', '-C', '/r', 'status']);
    const pairs = argv.slice(1, gitAt);
    assert.deepStrictEqual(pairs.filter((_, i) => i % 2 === 0), GIT_LOCATION_VARS.map(() => '-u'));
    assert.deepStrictEqual(pairs.filter((_, i) => i % 2 === 1), [...GIT_LOCATION_VARS]);
  });
  t('scrubGitEnv wraps a gh argv the same way', () => {
    const argv = mod.scrubGitEnv(['gh', 'api', 'graphql']);
    assert.strictEqual(argv[0], 'env');
    assert.deepStrictEqual(argv.slice(-3), ['gh', 'api', 'graphql']);
  });
  t('the wrapper really drops GIT_DIR (env -u, run for real)', () => {
    const { spawnSync } = require('child_process');
    const argv = mod.scrubGitEnv([process.execPath, '-p', "'GIT_DIR' in process.env"]);
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { ...process.env, GIT_DIR: '/x' } });
    assert.strictEqual(r.stdout.trim(), 'false');
  });
}

t('no mod file spawns git without the wrapper', () => {
  for (const f of fs.readdirSync(modDir).filter((n) => /\.tsx?$/.test(n) && n !== 'git-env.ts')) {
    const src = fs.readFileSync(path.join(modDir, f), 'utf8');
    assert.ok(!/\[\s*'git'/.test(src), `${f} builds a raw git argv; use gitArgv()`);
  }
});

t('map-pane gh calls are wrapped', () => {
  const src = fs.readFileSync(path.join(modDir, 'map-pane.tsx'), 'utf8');
  assert.ok(src.includes("scrubGitEnv(['gh', ...args])"));
});

console.log(`${passed} passed${mod ? '' : ' (type stripping unavailable: wrapper checks skipped)'}`);
