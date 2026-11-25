#!/usr/bin/env node
// Test dell'hook SessionStart trailhead-check-update.js (notice auth di gh).
// Run: node trailhead-check-update.test.js
// Un gh finto in una bin dir tmp (prima nel PATH) applica la precedenza reale.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const hookPath = path.join(__dirname, 'trailhead-check-update.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-check-update-test-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const fakeGh = `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] !== 'api' || a[1] !== 'user') process.exit(1); // altre chiamate (update check): innocue
const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const v = t ? t : (process.env.FAKE_GH_STORED || 'bad');
if (v === 'good') { console.log('octo'); process.exit(0); }
console.log('{"message":"Bad credentials","status":"401"}');
console.error('gh: Bad credentials (HTTP 401)');
process.exit(1);
`;
fs.writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 });

const repo = path.join(tmp, 'repo');
execFileSync('git', ['init', '-q', repo]);

function run(source, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  Object.assign(env, extraEnv, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_CACHE_HOME: path.join(tmp, 'cache'),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg'),
  });
  const input = { cwd: repo };
  if (source) input.source = source;
  const out = execFileSync('node', [hookPath], { input: JSON.stringify(input), encoding: 'utf8', env });
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}
const AUTH = 'GitHub rejects the';

for (const source of ['startup', 'clear', undefined]) {
  const ctx = run(source, { GITHUB_TOKEN: 'bad', FAKE_GH_STORED: 'good' });
  ok(`source ${source}: auth notice surfaced`, ctx.includes(`${AUTH} GITHUB_TOKEN`) && ctx.includes('GITHUB_TOKEN= gh'));
  ok(`source ${source}: token value not leaked`, !ctx.includes('bad'));
}
for (const source of ['resume', 'compact']) {
  ok(`source ${source}: no auth notice`, !run(source, { GITHUB_TOKEN: 'bad', FAKE_GH_STORED: 'good' }).includes(AUTH));
}
ok('no token var: no auth notice', !run('startup', { FAKE_GH_STORED: 'good' }).includes(AUTH));
ok('valid token: no auth notice', !run('startup', { GITHUB_TOKEN: 'good' }).includes(AUTH));

// --- notice update su Claude Code (#398) ---
const cfg = path.join(tmp, 'cfg');
const cacheDir = path.join(tmp, 'cache', 'trailhead');
const UPD = '/trailhead:update';
function seed(updateAvailable) {
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'trailhead@trailhead': [{ version: '0.14.0', installPath: '/x' }] } }));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'update-check.json'), JSON.stringify({
    channel: 'plugin', installed: '0.14.0', latest: '0.15.0', updateAvailable, where: '/x', checkedAt: Date.now(),
  }));
}
function settings(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}
const userSettings = path.join(cfg, 'settings.json');
const projSettings = path.join(repo, '.claude', 'settings.json');
const sl = (command) => ({ statusLine: { type: 'command', command } });
const reset = () => { fs.rmSync(userSettings, { force: true }); fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true }); };

seed(true);
reset();
ok('no statusLine: update notice shown', run('startup', {}).includes(UPD));
ok('update notice carries versions', run('startup', {}).includes('trailhead 0.15.0 is available (you have 0.14.0)'));
settings(userSettings, sl(`bash "${cfg}/statusline-trailhead.sh"`));
ok('trailhead statusline active: no notice', !run('startup', {}).includes(UPD));
settings(userSettings, sl(`bash "${cfg}/statusline-trailhead.sh" --ticket-only`));
ok('trailhead widget flag: notice shown', run('startup', {}).includes(UPD));
settings(userSettings, sl('npx -y ccstatusline@latest'));
ok('foreign statusline: notice shown', run('startup', {}).includes(UPD));
settings(userSettings, sl(`bash "${cfg}/statusline-trailhead.sh"`));
settings(projSettings, sl('ccstatusline'));
ok('project foreign overrides user trailhead: notice shown', run('startup', {}).includes(UPD));
reset();
settings(userSettings, '{ not json');
ok('malformed user settings: notice shown', run('startup', {}).includes(UPD));
reset();
seed(false);
ok('updateAvailable false: no notice', !run('startup', {}).includes(UPD));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`trailhead-check-update: ${passed} passed`);
