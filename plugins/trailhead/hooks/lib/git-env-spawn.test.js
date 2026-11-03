// Regression (#349): an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE must not
// redirect the plugin's git spawns away from the checkout they are pointed at.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const T = path.resolve(__dirname, '..', '..', 'templates');
let passed = 0;
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name); passed++; console.log('ok -', name); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-env-spawn-')));
const cleanEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(k)) delete e[k]; return e; };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
const a = makeRepo('a');
const b = makeRepo('b');
git(b, 'checkout', '-q', '-b', 'trailhead/t5');
git(b, 'commit', '-q', '--allow-empty', '-m', 'feat: work\n\nRefs: #5');
git(b, 'checkout', '-q', 'main');
const aHead = git(a, 'rev-parse', 'HEAD');
const bMain = git(b, 'rev-parse', 'main');
const bBranch = git(b, 'rev-parse', 'trailhead/t5');

// The hostile parent env: points every git call at a.
const hostile = { ...process.env, GIT_DIR: path.join(a, '.git'), GIT_WORK_TREE: a, GIT_INDEX_FILE: path.join(a, '.git', 'index') };
const node = (script, args, env) => spawnSync(process.execPath, [path.join(T, script), ...args], { encoding: 'utf8', env });

// checkout-in: a plain dir is no repo; with GIT_DIR set it must still be invalid.
const plain = path.join(tmp, 'plain');
fs.mkdirSync(plain);
const ci = node('trailhead-checkout-in.js', ['--in', plain, '--cwd', plain], hostile);
eq('checkout-in does not resolve a plain dir through GIT_DIR', JSON.parse(ci.stdout.trim()).status, 'invalid');

// auto-merge: merges into b, leaves a alone.
const am = node('trailhead-auto-merge.js', ['merge', '--repo', b, '--ticket', '5'], hostile);
const out = JSON.parse(am.stdout.trim());
eq('auto-merge merges into the target repo', [out.status, git(b, 'rev-parse', 'main')], ['merged', bBranch]);
eq('auto-merge leaves the GIT_DIR repo alone', git(a, 'rev-parse', 'HEAD'), aHead);
assert.notStrictEqual(bMain, bBranch);

// issue-body: the gh spawn (which asks git for the repo) must not see GIT_DIR.
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "dir=%s wt=%s idx=%s" "${GIT_DIR-unset}" "${GIT_WORK_TREE-unset}" "${GIT_INDEX_FILE-unset}"\n', { mode: 0o755 });
const probe = `process.stdout.write(require(${JSON.stringify(path.join(T, 'trailhead-issue-body.js'))}).defaultGh(['x']).stdout)`;
const ib = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...hostile, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
eq('issue-body gh spawn gets no repo-location vars', ib.stdout, 'dir=unset wt=unset idx=unset');

// The other gh-spawning templates share the same one-line scrub.
for (const f of ['unblock', 'uat-backfill', 'merge-ticket', 'needs-you', 'uat-followup', 'auto-queue', 'capture']) {
  const src = fs.readFileSync(path.join(T, `trailhead-${f}.js`), 'utf8');
  eq(`${f} gh spawn is scrubbed`, /spawnSync\('gh', args, \{[^}]*env: gitEnv\(\)/.test(src), true);
}

// The statusline keeps its own copy of the names: it must equal the template list.
const sl = fs.readFileSync(path.join(T, 'statusline-trailhead.sh'), 'utf8');
const unsetLine = sl.match(/^unset ((?:GIT_\w+[ \\\n]+)+)/m)[1].split(/[\s\\]+/).filter(Boolean);
eq('statusline unset list equals the template list', [...unsetLine].sort(), [...require(path.join(T, 'trailhead-git-env.js')).GIT_LOCATION_VARS].sort());

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${passed} passed`);
