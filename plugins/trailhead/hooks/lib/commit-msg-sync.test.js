#!/usr/bin/env node
// Tests for templates/trailhead-commit-msg-sync.js. Run: node commit-msg-sync.test.js
// No framework: plain asserts, mirrors the style of commit-message-check.test.js.
//
// Covers three layers:
//   1. isTrailheadHook() / normalize() unit cases.
//   2. syncCommitMsgHook() unit cases against mkdtemp hook dirs (fs seam left
//      as the real fs; each case gets its own scratch dir).
//   3. resolveHooksTarget() with a stubbed runGit (no shelling out).
//   4. End-to-end: execFileSync the script itself against real git repos.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-commit-msg-sync.js');
const templatePath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-commit-msg');
const oldFixturePath = path.join(__dirname, 'fixtures', 'commit-msg-a319156');

const {
  resolveHooksTarget,
  isTrailheadHook,
  normalize,
  syncCommitMsgHook,
} = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const templateText = fs.readFileSync(templatePath, 'utf8');
const oldHookText = fs.readFileSync(oldFixturePath, 'utf8');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-commit-msg-sync-test-'));
}

// --- isTrailheadHook() unit cases -------------------------------------------
ok('isTrailheadHook: current template is recognised', isTrailheadHook(templateText));
ok('isTrailheadHook: old (a319156) hook is recognised', isTrailheadHook(oldHookText));
ok('isTrailheadHook: plain foreign script is not', !isTrailheadHook('#!/bin/sh\necho hi\n'));
ok('isTrailheadHook: mention outside the first 5 lines, not line-start, is not',
  !isTrailheadHook('#!/bin/sh\necho hi\necho more\necho stuff\necho again\n# trailhead commit-msg hook (git). fake\n'));
ok('isTrailheadHook: mention inside an echo on line 2 is not',
  !isTrailheadHook('#!/bin/sh\necho "trailhead commit-msg hook (git)."\n'));
ok('isTrailheadHook: empty text is not', !isTrailheadHook(''));

// --- normalize() unit cases --------------------------------------------------
ok('normalize: CRLF becomes LF', normalize('a\r\nb\r\n') === 'a\nb\n');
ok('normalize: LF-only text is unchanged', normalize('a\nb\n') === 'a\nb\n');

// --- syncCommitMsgHook() unit cases ------------------------------------------
function modeOf(p) { return fs.statSync(p).mode & 0o777; }

// absent -> installed, 0755
{
  const dir = mktmp();
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: false, fs });
  const hookPath = path.join(dir, 'commit-msg');
  ok('syncCommitMsgHook: absent -> installed', result.status === 'installed');
  ok('syncCommitMsgHook: absent -> hook path returned', result.hook === hookPath);
  ok('syncCommitMsgHook: absent -> file written', fs.existsSync(hookPath));
  ok('syncCommitMsgHook: absent -> content matches template', fs.readFileSync(hookPath, 'utf8') === templateText);
  ok('syncCommitMsgHook: absent -> mode 0755', modeOf(hookPath) === 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
}

// old -> upgraded, bytes === template, 0755
{
  const dir = mktmp();
  const hookPath = path.join(dir, 'commit-msg');
  fs.writeFileSync(hookPath, oldHookText);
  fs.chmodSync(hookPath, 0o755);
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: false, fs });
  ok('syncCommitMsgHook: old -> upgraded', result.status === 'upgraded');
  ok('syncCommitMsgHook: old -> bytes now match template', fs.readFileSync(hookPath, 'utf8') === templateText);
  ok('syncCommitMsgHook: old -> mode 0755', modeOf(hookPath) === 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
}

// CRLF current -> current, untouched
{
  const dir = mktmp();
  const hookPath = path.join(dir, 'commit-msg');
  const crlfTemplate = templateText.replace(/\n/g, '\r\n');
  fs.writeFileSync(hookPath, crlfTemplate);
  fs.chmodSync(hookPath, 0o755);
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: false, fs });
  ok('syncCommitMsgHook: CRLF current -> current', result.status === 'current');
  ok('syncCommitMsgHook: CRLF current -> untouched bytes', fs.readFileSync(hookPath, 'utf8') === crlfTemplate);
  fs.rmSync(dir, { recursive: true, force: true });
}

// current but mode 0644 -> current, mode fixed to 0755
{
  const dir = mktmp();
  const hookPath = path.join(dir, 'commit-msg');
  fs.writeFileSync(hookPath, templateText);
  fs.chmodSync(hookPath, 0o644);
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: false, fs });
  ok('syncCommitMsgHook: current 0644 -> status current', result.status === 'current');
  ok('syncCommitMsgHook: current 0644 -> mode fixed to 0755', modeOf(hookPath) === 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
}

// foreign shell script -> foreign, untouched
{
  const dir = mktmp();
  const hookPath = path.join(dir, 'commit-msg');
  const foreign = '#!/bin/sh\necho hi\n';
  fs.writeFileSync(hookPath, foreign);
  fs.chmodSync(hookPath, 0o755);
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: false, fs });
  ok('syncCommitMsgHook: foreign shell -> foreign', result.status === 'foreign');
  ok('syncCommitMsgHook: foreign shell -> bytes untouched', fs.readFileSync(hookPath, 'utf8') === foreign);
  ok('syncCommitMsgHook: foreign shell -> mode untouched', modeOf(hookPath) === 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
}

// foreign wrapper mentioning the phrase in an echo on line 2 -> foreign
{
  const dir = mktmp();
  const hookPath = path.join(dir, 'commit-msg');
  const foreign = '#!/bin/sh\necho "trailhead commit-msg hook (git). not really"\nexit 0\n';
  fs.writeFileSync(hookPath, foreign);
  fs.chmodSync(hookPath, 0o755);
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: false, fs });
  ok('syncCommitMsgHook: foreign wrapper mentioning phrase -> foreign', result.status === 'foreign');
  ok('syncCommitMsgHook: foreign wrapper -> bytes untouched', fs.readFileSync(hookPath, 'utf8') === foreign);
  fs.rmSync(dir, { recursive: true, force: true });
}

// symlink -> foreign, target untouched
{
  const dir = mktmp();
  const hookPath = path.join(dir, 'commit-msg');
  const targetPath = path.join(dir, 'real-hook.sh');
  const targetContent = '#!/bin/sh\necho real\n';
  fs.writeFileSync(targetPath, targetContent);
  fs.symlinkSync(targetPath, hookPath);
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: false, fs });
  ok('syncCommitMsgHook: symlink -> foreign', result.status === 'foreign');
  ok('syncCommitMsgHook: symlink -> still a symlink', fs.lstatSync(hookPath).isSymbolicLink());
  ok('syncCommitMsgHook: symlink target untouched', fs.readFileSync(targetPath, 'utf8') === targetContent);
  fs.rmSync(dir, { recursive: true, force: true });
}

// absent + hooksPathSet -> skipped, nothing created
{
  const dir = mktmp();
  const hookPath = path.join(dir, 'commit-msg');
  const result = syncCommitMsgHook({ hooksDir: dir, templateText, hooksPathSet: true, fs });
  ok('syncCommitMsgHook: absent + hooksPathSet -> skipped', result.status === 'skipped');
  ok('syncCommitMsgHook: absent + hooksPathSet -> nothing created', !fs.existsSync(hookPath));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- resolveHooksTarget() with a stubbed runGit ------------------------------
{
  const stubThrow = () => { throw new Error('not a git repo'); };
  const result = resolveHooksTarget({ repoDir: '/nonexistent-repo-dir', runGit: stubThrow });
  ok('resolveHooksTarget: no-repo -> skip', result.skip === 'no-repo');
}
{
  let calls = 0;
  const runGit = (args) => {
    calls++;
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') return '.git';
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return '.git/hooks';
    if (args[0] === 'config') throw new Error('not set');
    throw new Error('unexpected args: ' + args.join(' '));
  };
  const result = resolveHooksTarget({ repoDir: '/some/repo', runGit });
  ok('resolveHooksTarget: hooksDir resolved against repoDir', result.hooksDir === path.resolve('/some/repo', '.git/hooks'));
  ok('resolveHooksTarget: hooksPathSet false when core.hooksPath unset', result.hooksPathSet === false);
  ok('resolveHooksTarget: runGit called', calls >= 2);
}
{
  const runGit = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') return '.git';
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return '.git/hooks';
    if (args[0] === 'config') return '.githooks';
    throw new Error('unexpected args: ' + args.join(' '));
  };
  const result = resolveHooksTarget({ repoDir: '/some/repo', runGit });
  ok('resolveHooksTarget: hooksPathSet true when core.hooksPath set', result.hooksPathSet === true);
}

console.log(`✓ commit-msg-sync (unit): ${passed} assertions passed`);

// --- end-to-end: drive the script itself against real git repos -------------
function gitEnv(extra) {
  return Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Trailhead Test',
    GIT_AUTHOR_EMAIL: 'trailhead-test@example.com',
    GIT_COMMITTER_NAME: 'Trailhead Test',
    GIT_COMMITTER_EMAIL: 'trailhead-test@example.com',
  }, extra || {});
}

function runScript(args, opts) {
  const out = execFileSync(process.execPath, [scriptPath].concat(args), Object.assign({ encoding: 'utf8' }, opts));
  return out;
}

function assertSingleJsonLine(out, label) {
  const lines = out.split('\n').filter((l) => l.length > 0);
  ok(`${label}: stdout is exactly one line`, lines.length === 1);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(lines[0]); }, `${label}: stdout line is valid JSON`);
  passed++;
  ok(`${label}: JSON has exactly [status, hook, message] keys`,
    Object.keys(parsed).sort().join(',') === 'hook,message,status');
  return parsed;
}

// fresh repo: installed, then current on a second run
{
  const dir = mktmp();
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  const out1 = runScript(['--repo', dir], { env: gitEnv() });
  const parsed1 = assertSingleJsonLine(out1, 'e2e fresh repo (1st run)');
  ok('e2e fresh repo: status installed', parsed1.status === 'installed');
  const hookPath = path.join(dir, '.git', 'hooks', 'commit-msg');
  ok('e2e fresh repo: hook file exists', fs.existsSync(hookPath));
  ok('e2e fresh repo: hook is executable', (modeOf(hookPath) & 0o111) !== 0);

  const out2 = runScript(['--repo', dir], { env: gitEnv() });
  const parsed2 = assertSingleJsonLine(out2, 'e2e fresh repo (2nd run)');
  ok('e2e fresh repo (2nd run): status current', parsed2.status === 'current');
  fs.rmSync(dir, { recursive: true, force: true });
}

// seeded old hook -> upgraded
{
  const dir = mktmp();
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  const hooksDir = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'commit-msg');
  fs.writeFileSync(hookPath, oldHookText);
  fs.chmodSync(hookPath, 0o755);
  const out = runScript(['--repo', dir], { env: gitEnv() });
  const parsed = assertSingleJsonLine(out, 'e2e seeded old hook');
  ok('e2e seeded old hook: status upgraded', parsed.status === 'upgraded');
  ok('e2e seeded old hook: content now matches template', fs.readFileSync(hookPath, 'utf8') === templateText);
  fs.rmSync(dir, { recursive: true, force: true });
}

// seeded foreign hook -> untouched
{
  const dir = mktmp();
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  const hooksDir = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'commit-msg');
  const foreign = '#!/bin/sh\necho "custom hook"\n';
  fs.writeFileSync(hookPath, foreign);
  fs.chmodSync(hookPath, 0o755);
  const out = runScript(['--repo', dir], { env: gitEnv() });
  const parsed = assertSingleJsonLine(out, 'e2e seeded foreign hook');
  ok('e2e seeded foreign hook: status foreign', parsed.status === 'foreign');
  ok('e2e seeded foreign hook: bytes untouched', fs.readFileSync(hookPath, 'utf8') === foreign);
  fs.rmSync(dir, { recursive: true, force: true });
}

// core.hooksPath = .githooks, absent -> skipped, nothing created anywhere
{
  const dir = mktmp();
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir, env: gitEnv() });
  const out = runScript(['--repo', dir], { env: gitEnv() });
  const parsed = assertSingleJsonLine(out, 'e2e core.hooksPath absent');
  ok('e2e core.hooksPath absent: status skipped', parsed.status === 'skipped');
  ok('e2e core.hooksPath absent: .githooks/commit-msg not created', !fs.existsSync(path.join(dir, '.githooks', 'commit-msg')));
  ok('e2e core.hooksPath absent: .git/hooks/commit-msg not created', !fs.existsSync(path.join(dir, '.git', 'hooks', 'commit-msg')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// core.hooksPath = .githooks, old hook there -> upgraded there
{
  const dir = mktmp();
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir, env: gitEnv() });
  const githooksDir = path.join(dir, '.githooks');
  fs.mkdirSync(githooksDir, { recursive: true });
  const hookPath = path.join(githooksDir, 'commit-msg');
  fs.writeFileSync(hookPath, oldHookText);
  fs.chmodSync(hookPath, 0o755);
  const out = runScript(['--repo', dir], { env: gitEnv() });
  const parsed = assertSingleJsonLine(out, 'e2e core.hooksPath old hook');
  ok('e2e core.hooksPath old hook: status upgraded', parsed.status === 'upgraded');
  ok('e2e core.hooksPath old hook: upgraded in .githooks', fs.readFileSync(hookPath, 'utf8') === templateText);
  fs.rmSync(dir, { recursive: true, force: true });
}

// core.hooksPath = .githooks, foreign hook there -> untouched
{
  const dir = mktmp();
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir, env: gitEnv() });
  const githooksDir = path.join(dir, '.githooks');
  fs.mkdirSync(githooksDir, { recursive: true });
  const hookPath = path.join(githooksDir, 'commit-msg');
  const foreign = '#!/bin/sh\necho "custom"\n';
  fs.writeFileSync(hookPath, foreign);
  fs.chmodSync(hookPath, 0o755);
  const out = runScript(['--repo', dir], { env: gitEnv() });
  const parsed = assertSingleJsonLine(out, 'e2e core.hooksPath foreign hook');
  ok('e2e core.hooksPath foreign hook: status foreign', parsed.status === 'foreign');
  ok('e2e core.hooksPath foreign hook: untouched', fs.readFileSync(hookPath, 'utf8') === foreign);
  fs.rmSync(dir, { recursive: true, force: true });
}

// linked worktree -> hook lands in the main repo's .git/hooks
{
  const dir = mktmp();
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'chore: init', '--no-verify',
    '-c', 'user.name=t', '-c', 'user.email=t@t'], { cwd: dir, env: gitEnv() });
  const worktreeDir = path.join(dir, '..', path.basename(dir) + '-wt');
  execFileSync('git', ['worktree', 'add', worktreeDir, '-b', 'trailhead-wt'], { cwd: dir, env: gitEnv() });
  try {
    const out = runScript(['--repo', worktreeDir], { env: gitEnv() });
    const parsed = assertSingleJsonLine(out, 'e2e linked worktree');
    ok('e2e linked worktree: status installed', parsed.status === 'installed');
    const mainHookPath = path.join(dir, '.git', 'hooks', 'commit-msg');
    ok('e2e linked worktree: hook lands in the main repo .git/hooks', fs.existsSync(mainHookPath));
    ok('e2e linked worktree: reported hook path is the main repo one', parsed.hook === mainHookPath);
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: dir, env: gitEnv() }); } catch { /* best effort cleanup */ }
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// non-repo tmp dir -> skipped, exit 0
{
  const dir = mktmp();
  const out = runScript(['--repo', dir], { env: gitEnv() });
  const parsed = assertSingleJsonLine(out, 'e2e non-repo dir');
  ok('e2e non-repo dir: status skipped', parsed.status === 'skipped');
  ok('e2e non-repo dir: hook is null', parsed.hook === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --bogus -> exit 2
{
  const dir = mktmp();
  let exitCode = null;
  try {
    execFileSync(process.execPath, [scriptPath, '--bogus'], { cwd: dir, env: gitEnv(), stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status;
  }
  ok('e2e --bogus: exits 2', exitCode === 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --repo without a value -> exit 2
{
  const dir = mktmp();
  let exitCode = null;
  try {
    execFileSync(process.execPath, [scriptPath, '--repo'], { cwd: dir, env: gitEnv(), stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status;
  }
  ok('e2e --repo without value: exits 2', exitCode === 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`✓ commit-msg-sync (e2e): ${passed} assertions passed`);
