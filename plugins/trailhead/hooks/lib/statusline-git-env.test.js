#!/usr/bin/env node
// #349: an exported GIT_DIR must not make the statusline describe another repo.
// Run: node statusline-git-env.test.js
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const script = path.resolve(__dirname, '..', '..', 'templates', 'statusline-trailhead.sh');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-statusline-git-')));
const home = path.join(root, 'home');
fs.mkdirSync(home);

const cleanEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(k)) delete e[k]; return e; };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
const mk = (name, branch) => {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  git(d, 'init', '-q', '-b', branch);
  git(d, 'commit', '-q', '--allow-empty', '-m', 'init');
  return d;
};
const a = mk('alpha', 'branch-a');
const b = mk('beta', 'branch-b');

function render(env) {
  const input = { model: { id: 'claude-opus-5-5', display_name: 'Test' }, workspace: { project_dir: b, current_dir: b } };
  const r = spawnSync('bash', [script], {
    input: JSON.stringify(input),
    env: { ...cleanEnv(), NO_COLOR: '1', TRAILHEAD_STATUSLINE_USAGE: '0', HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'cfg'), ...env },
    encoding: 'utf8',
  });
  return r.stdout;
}

const clean = render({});
assert.ok(clean.includes('beta') && clean.includes('branch-b'), `baseline: ${clean}`);
const hostile = render({ GIT_DIR: path.join(a, '.git'), GIT_WORK_TREE: a });
assert.ok(hostile.includes('beta'), `project follows the cwd, not GIT_DIR: ${hostile}`);
assert.ok(hostile.includes('branch-b') && !hostile.includes('branch-a'), `branch follows the cwd, not GIT_DIR: ${hostile}`);

fs.rmSync(root, { recursive: true, force: true });
console.log('3 passed');
