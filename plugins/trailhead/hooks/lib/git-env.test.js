// Tests of templates/trailhead-git-env.js (and its hooks/lib copy).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { GIT_LOCATION_VARS, gitEnv } = require('../../templates/trailhead-git-env.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('removes every repo-location name', () => {
  const base = { PATH: '/bin' };
  for (const k of GIT_LOCATION_VARS) base[k] = 'x';
  assert.deepStrictEqual(gitEnv(base), { PATH: '/bin' });
});

t('keeps GIT_CONFIG* and unrelated names', () => {
  const base = { GIT_DIR: 'x', GIT_CONFIG: 'a', GIT_CONFIG_PARAMETERS: 'b', GIT_CONFIG_COUNT: '1', HOME: '/h' };
  assert.deepStrictEqual(gitEnv(base), { GIT_CONFIG: 'a', GIT_CONFIG_PARAMETERS: 'b', GIT_CONFIG_COUNT: '1', HOME: '/h' });
});

t('extra is applied on top and may re-add a name', () => {
  assert.deepStrictEqual(gitEnv({ GIT_DIR: 'x', A: '1' }, { A: '2', GIT_EDITOR: 'true' }), { A: '2', GIT_EDITOR: 'true' });
});

t('does not mutate its input or process.env', () => {
  const base = Object.freeze({ GIT_DIR: 'x' });
  gitEnv(base);
  assert.strictEqual(base.GIT_DIR, 'x');
  process.env.GIT_DIR = '/nonexistent-for-test';
  try {
    assert.ok(!('GIT_DIR' in gitEnv()));
    assert.strictEqual(process.env.GIT_DIR, '/nonexistent-for-test');
  } finally { delete process.env.GIT_DIR; }
});

t('the name list is git\'s local env vars minus GIT_CONFIG*', () => {
  const r = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  if (r.status !== 0) return;
  const expected = r.stdout.split('\n').filter((s) => s && !s.startsWith('GIT_CONFIG')).sort();
  const missing = expected.filter((k) => !GIT_LOCATION_VARS.includes(k));
  assert.deepStrictEqual(missing, [], 'git knows local env vars the list lacks');
});

t('hooks/lib copy is byte-identical to the template', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'trailhead-git-env.js'));
  const b = fs.readFileSync(path.join(__dirname, 'trailhead-git-env.js'));
  assert.ok(a.equals(b));
});

console.log(`${n} passed`);
