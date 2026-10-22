#!/usr/bin/env node
// Tests for templates/trailhead-auto-merge.js. Run: node auto-merge.test.js
// No framework: plain asserts, same style as auto-slot.test.js.
//
// Layers covered:
//   1. merge / recover / remove against REAL temporary git repos (the default git runner).
//   2. An injected git runner that fails `merge --abort` (the reset --merge fallback).
//   3. Cross-helper check with trailhead-base-preflight.js.
//   4. Usage errors (exit 2) and one end-to-end spawn of the script.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-auto-merge.js');
const preflightPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-base-preflight.js');
const commitMsgPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-commit-msg.cjs');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const gitOk = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).status === 0;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const commitFile = (cwd, name, text, msg) => {
  write(path.join(cwd, name), text);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
};

// <parent>/repo on main with a.txt and a .gitignore hiding .trailhead/. Returns { parent, repo, base }.
function makeRepo() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-merge-')));
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(path.join(repo, '.gitignore'), '.trailhead/\n');
  write(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.gitignore', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'chore: first');
  return { parent, repo, base: git(repo, 'rev-parse', 'HEAD') };
}

// Opens the slot worktree of ticket n at `base` and commits one file in it.
function makeSlot(ctx, n, file, text, base = ctx.base) {
  const wt = path.join(ctx.parent, `repo-t${n}`);
  git(ctx.repo, 'worktree', 'add', '-q', '-b', `trailhead/t${n}`, wt, base);
  commitFile(wt, file, text, `feat: work on ${file}\n\nRefs: #${n}`);
  return wt;
}

function installHook(repo) {
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
  write(hook, `#!/bin/sh\nnode "${commitMsgPath}" "$1"\nc=$?\n[ "$c" -eq 3 ] && exit 1\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
}

function run(argv, deps = {}) {
  let out = '';
  let errOut = '';
  const code = main(argv, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } }, ...deps });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json, errOut };
}
const merge = (repo, n, deps, extra = []) => run(['merge', '--repo', repo, '--ticket', String(n), ...extra], deps);
const recover = (repo, deps) => run(['recover', '--repo', repo], deps);
const remove = (repo, n, deps, extra = []) => run(['remove', '--repo', repo, '--ticket', String(n), ...extra], deps);
const cleanup = (ctx) => fs.rmSync(ctx.parent, { recursive: true, force: true });
const gitPath = (repo, name) => path.resolve(repo, git(repo, 'rev-parse', '--git-path', name));

// Leaves a real conflicting run merge in place (what a crash mid-merge looks like).
function leaveRunMerge(ctx, n) {
  const r = spawnSync('git', ['-C', ctx.repo, 'merge', '--no-edit', '-m', `chore(auto): merge trailhead/t${n}`, '-m', `Refs: #${n}`, `trailhead/t${n}`], { encoding: 'utf8' });
  assert.ok(r.status !== 0 && fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')), 'a merge was left in place');
}

// --- fast-forward merge ------------------------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  const tip = git(ctx.repo, 'rev-parse', 'trailhead/t7');
  const r = merge(ctx.repo, 7);
  ok('merge: ff exits 0 with status merged', r.code === 0 && r.json.status === 'merged');
  ok('merge: ff method, from, head', r.json.method === 'ff' && r.json.from === ctx.base && r.json.head === tip);
  ok('merge: the trunk now holds the tip', git(ctx.repo, 'rev-parse', 'main') === tip && fs.existsSync(path.join(ctx.repo, 'b.txt')));
  ok('merge: a second call is idempotent (already-merged)', merge(ctx.repo, 7).json.status === 'already-merged');
  cleanup(ctx);
}

// --- true merge commit (trunk moved) -----------------------------------------
{
  const ctx = makeRepo();
  installHook(ctx.repo);
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  const moved = commitFile(ctx.repo, 'c.txt', 'c\n', 'feat: trunk moved');
  const r = merge(ctx.repo, 7);
  ok('merge: a moved trunk gives a merge commit', r.code === 0 && r.json.status === 'merged' && r.json.method === 'merge' && r.json.from === moved);
  const msg = git(ctx.repo, 'log', '-1', '--format=%B');
  ok('merge: conventional subject and Refs trailer', msg.split('\n')[0] === 'chore(auto): merge trailhead/t7' && /^Refs: #7$/m.test(msg));
  ok('merge: two parents, tip is an ancestor', gitOk(ctx.repo, 'rev-parse', '--verify', '-q', 'HEAD^2') && gitOk(ctx.repo, 'merge-base', '--is-ancestor', 'trailhead/t7', 'HEAD'));
  ok('merge: nothing is pushed or created elsewhere', git(ctx.repo, 'branch', '--list', 'trailhead/t7') !== '' && r.json.head === git(ctx.repo, 'rev-parse', 'HEAD'));
  cleanup(ctx);
}

// --- trunk resolution ---------------------------------------------------------
{
  const ctx = makeRepo();
  git(ctx.repo, 'branch', '-m', 'main', 'master');
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  ok('merge: falls back to master when there is no main', merge(ctx.repo, 7).json.status === 'merged');
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  const r = merge(ctx.repo, 7, undefined, ['--trunk', 'develop']);
  ok('merge: an unknown --trunk is an error', r.code === 1 && r.json.status === 'error');
  git(ctx.repo, 'branch', '-m', 'main', 'weird');
  const r2 = merge(ctx.repo, 7);
  ok('merge: no trunk found is an error', r2.code === 1 && r2.json.status === 'error' && /trunk/.test(r2.json.reason));
  ok('merge: explicit --trunk is honoured', merge(ctx.repo, 7, undefined, ['--trunk', 'weird']).json.status === 'merged');
  cleanup(ctx);
}

// --- conflict -> aborted, recorded ---------------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'a.txt', 'slot\n');
  const moved = commitFile(ctx.repo, 'a.txt', 'trunk\n', 'feat: trunk edits a');
  const r = merge(ctx.repo, 7);
  ok('merge: conflict status with files', r.code === 0 && r.json.status === 'conflict' && JSON.stringify(r.json.conflicts) === '["a.txt"]');
  ok('merge: HEAD is back at pre', git(ctx.repo, 'rev-parse', 'HEAD') === moved);
  ok('merge: no merge left behind and tree clean', !fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')) && git(ctx.repo, 'status', '--porcelain', '--untracked-files=no') === '');
  ok('merge: the branch is intact', git(ctx.repo, 'show', 'trailhead/t7:a.txt') === 'slot');
  const again = merge(ctx.repo, 7);
  ok('merge: a retry reports the conflict again', again.json.status === 'conflict');
  cleanup(ctx);
}

// --- preconditions ---------------------------------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  git(ctx.repo, 'checkout', '-q', '-b', 'other');
  const r = merge(ctx.repo, 7);
  ok('merge: not-on-trunk', r.code === 0 && r.json.status === 'not-on-trunk');
  ok('merge: not-on-trunk touches nothing', git(ctx.repo, 'rev-parse', 'HEAD') === ctx.base && !fs.existsSync(path.join(ctx.repo, 'b.txt')));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  write(path.join(ctx.repo, 'a.txt'), 'dirty\n');
  const r = merge(ctx.repo, 7);
  ok('merge: dirty tracked tree', r.json.status === 'dirty' && fs.readFileSync(path.join(ctx.repo, 'a.txt'), 'utf8') === 'dirty\n' && git(ctx.repo, 'rev-parse', 'HEAD') === ctx.base);
  git(ctx.repo, 'checkout', '-q', '--', 'a.txt');
  write(path.join(ctx.repo, 'untracked.txt'), 'u\n');
  ok('merge: an untracked file is not dirty', merge(ctx.repo, 7).json.status === 'merged');
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  const wt = makeSlot(ctx, 7, 'b.txt', 'b\n');
  write(path.join(wt, 'b.txt'), 'uncommitted\n');
  const r = merge(ctx.repo, 7);
  ok('merge: slot-dirty when the slot has uncommitted tracked work', r.json.status === 'slot-dirty' && git(ctx.repo, 'rev-parse', 'HEAD') === ctx.base);
  git(wt, 'checkout', '-q', '--', 'b.txt');
  write(path.join(wt, '.trailhead', 'work-state.json'), '{}\n');
  ok('merge: ignored slot state files are not slot-dirty', merge(ctx.repo, 7).json.status === 'merged');
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  const r = merge(ctx.repo, 9);
  ok('merge: a missing branch is an error', r.code === 1 && r.json.status === 'error' && /trailhead\/t9/.test(r.json.reason));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'a.txt', 'slot\n');
  commitFile(ctx.repo, 'a.txt', 'trunk\n', 'feat: trunk edits a');
  leaveRunMerge(ctx, 7);
  const r = merge(ctx.repo, 7);
  ok('merge: in-progress when a merge is already under way', r.code === 0 && r.json.status === 'in-progress');
  ok('merge: in-progress leaves the merge untouched', fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')));
  git(ctx.repo, 'merge', '--abort');
  fs.mkdirSync(gitPath(ctx.repo, 'rebase-merge'), { recursive: true });
  ok('merge: in-progress for a rebase too', merge(ctx.repo, 7).json.status === 'in-progress');
  cleanup(ctx);
}

// --- marker ------------------------------------------------------------------------
{
  // marker di un altro ticket: il fast-forward non crea commit, procede sempre
  const ctx = makeRepo();
  installHook(ctx.repo);
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  write(path.join(ctx.repo, '.trailhead', 'session-ticket'), '#12 another ticket\n');
  const r = merge(ctx.repo, 7);
  ok('merge: a foreign marker does not block a fast-forward', r.code === 0 && r.json.status === 'merged' && r.json.method === 'ff');
  ok('merge: the marker is never rewritten', fs.readFileSync(path.join(ctx.repo, '.trailhead', 'session-ticket'), 'utf8') === '#12 another ticket\n');
  cleanup(ctx);
}
{
  // marker di un altro ticket: il merge commit passa con --no-verify, hook attivo che lo rifiuterebbe
  const ctx = makeRepo();
  installHook(ctx.repo);
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  commitFile(ctx.repo, 'c.txt', 'c\n', 'feat: trunk moved\n\nRefs: #12');
  write(path.join(ctx.repo, '.trailhead', 'session-ticket'), '#12 another ticket\n');
  const r = merge(ctx.repo, 7);
  ok('merge: a foreign marker does not block a true merge', r.code === 0 && r.json.status === 'merged' && r.json.method === 'merge');
  ok('merge: the merge commit carries the merged ticket trailer', /Refs: #7\s*$/.test(git(ctx.repo, 'log', '-1', '--format=%B')) && git(ctx.repo, 'log', '-1', '--format=%s') === 'chore(auto): merge trailhead/t7');
  ok('merge: the marker is still untouched after a true merge', fs.readFileSync(path.join(ctx.repo, '.trailhead', 'session-ticket'), 'utf8') === '#12 another ticket\n');
  cleanup(ctx);
}
for (const [label, marker] of [['a matching marker', '#7 this ticket\n'], ['no marker', null]]) {
  // --no-verify solo con marker di un altro ticket
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  commitFile(ctx.repo, 'c.txt', 'c\n', 'feat: trunk moved');
  if (marker) write(path.join(ctx.repo, '.trailhead', 'session-ticket'), marker);
  const calls = [];
  const spy = (args) => {
    calls.push(args.join(' '));
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const r = merge(ctx.repo, 7, { git: spy });
  const mergeCall = calls.find((c) => / merge --no-edit /.test(c));
  ok(`merge: ${label} merges without --no-verify`, r.json.status === 'merged' && !!mergeCall && !/--no-verify/.test(mergeCall));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  commitFile(ctx.repo, 'c.txt', 'c\n', 'feat: trunk moved');
  write(path.join(ctx.repo, '.trailhead', 'session-ticket'), '#12 another ticket\n');
  const calls = [];
  const spy = (args) => {
    calls.push(args.join(' '));
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const r = merge(ctx.repo, 7, { git: spy });
  const mergeCall = calls.find((c) => / merge --no-edit /.test(c));
  ok('merge: a foreign marker adds --no-verify to the merge', r.json.status === 'merged' && !!mergeCall && /--no-verify/.test(mergeCall));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  installHook(ctx.repo);
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  commitFile(ctx.repo, 'c.txt', 'c\n', 'feat: trunk moved');
  write(path.join(ctx.repo, '.trailhead', 'session-ticket'), '#7 this ticket\n');
  const r = merge(ctx.repo, 7);
  ok('merge: the merge commit passes the real commit-msg hook with a matching marker', r.json.status === 'merged' && r.json.method === 'merge');
  cleanup(ctx);
}

// --- hook refusing -> merge-failed ------------------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  const moved = commitFile(ctx.repo, 'c.txt', 'c\n', 'feat: trunk moved');
  write(path.join(ctx.repo, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "refused" >&2\nexit 1\n');
  fs.chmodSync(path.join(ctx.repo, '.git', 'hooks', 'commit-msg'), 0o755);
  const r = merge(ctx.repo, 7);
  ok('merge: a refusing hook gives merge-failed with a message', r.code === 0 && r.json.status === 'merge-failed' && typeof r.json.reason === 'string' && r.json.reason.length > 0);
  ok('merge: main is clean after a refused merge', git(ctx.repo, 'rev-parse', 'HEAD') === moved && !fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')) && git(ctx.repo, 'status', '--porcelain', '--untracked-files=no') === '');
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  write(path.join(ctx.repo, 'b.txt'), 'untracked in the way\n');
  const r = merge(ctx.repo, 7);
  ok('merge: an untracked file in the way is merge-failed', r.json.status === 'merge-failed' && git(ctx.repo, 'rev-parse', 'HEAD') === ctx.base);
  ok('merge: the untracked file survives', fs.readFileSync(path.join(ctx.repo, 'b.txt'), 'utf8') === 'untracked in the way\n');
  cleanup(ctx);
}

// --- abort failure -> reset --merge fallback ---------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'a.txt', 'slot\n');
  const moved = commitFile(ctx.repo, 'a.txt', 'trunk\n', 'feat: trunk edits a');
  const calls = [];
  const failingAbort = (args) => {
    calls.push(args.join(' '));
    if (args.includes('merge') && args.includes('--abort')) return { status: 1, stdout: '', stderr: 'forced abort failure' };
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const r = merge(ctx.repo, 7, { git: failingAbort });
  ok('merge: conflict is still reported when abort fails', r.json.status === 'conflict' && JSON.stringify(r.json.conflicts) === '["a.txt"]');
  ok('merge: the fallback ran reset --merge, never --hard or --force', calls.some((c) => c.includes('reset --merge')) && !calls.some((c) => /--hard|--force/.test(c)));
  ok('merge: main is back at pre after the fallback', git(ctx.repo, 'rev-parse', 'HEAD') === moved && !fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'a.txt', 'slot\n');
  commitFile(ctx.repo, 'a.txt', 'trunk\n', 'feat: trunk edits a');
  const stuck = (args) => {
    if (args.includes('--abort') || (args.includes('reset') && args.includes('--merge'))) return { status: 1, stdout: '', stderr: 'forced failure' };
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const r = merge(ctx.repo, 7, { git: stuck });
  ok('merge: main left mid-merge is the one hard error', r.code === 1 && r.json.status === 'error' && /mid-merge/.test(r.json.reason));
  cleanup(ctx);
}

// --- behind -------------------------------------------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  makeSlot(ctx, 8, 'd.txt', 'd\n');
  const r = merge(ctx.repo, 7);
  ok('merge: behind lists the other slot', Array.isArray(r.json.behind) && r.json.behind.length === 1 && r.json.behind[0].ticket === 8 && r.json.behind[0].behind === 1 && r.json.behind[0].path === path.join(ctx.parent, 'repo-t8'));
  const again = merge(ctx.repo, 7);
  ok('merge: already-merged reports behind too', again.json.status === 'already-merged' && again.json.behind.length === 1);
  cleanup(ctx);
}

// --- cross-helper: base-preflight on another slot --------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  const other = makeSlot(ctx, 8, 'd.txt', 'd\n');
  merge(ctx.repo, 7);
  const p = spawnSync('node', [preflightPath, '--repo', other, '--no-fetch'], { encoding: 'utf8' });
  const j = JSON.parse(p.stdout.trim());
  ok('cross-helper: the other slot is behind with base the local trunk', j.status === 'behind' && j.base === 'main' && j.behind === 1);
  cleanup(ctx);
}

// --- recover ---------------------------------------------------------------------------
{
  const ctx = makeRepo();
  ok('recover: clean when nothing is under way', recover(ctx.repo).json.status === 'clean');
  makeSlot(ctx, 7, 'a.txt', 'slot\n');
  const moved = commitFile(ctx.repo, 'a.txt', 'trunk\n', 'feat: trunk edits a');
  leaveRunMerge(ctx, 7);
  const r = recover(ctx.repo);
  ok('recover: aborts an interrupted run merge, naming the ticket', r.code === 0 && r.json.status === 'aborted' && r.json.ticket === 7);
  ok('recover: main is back at HEAD, clean, no merge', git(ctx.repo, 'rev-parse', 'HEAD') === moved && !fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')) && git(ctx.repo, 'status', '--porcelain', '--untracked-files=no') === '');
  ok('recover: a second call is clean', recover(ctx.repo).json.status === 'clean');
  ok('recover: the retry reports the conflict again', merge(ctx.repo, 7).json.status === 'conflict');
  // The conflict goes away on the trunk side: the retry now merges.
  git(ctx.repo, 'revert', '--no-edit', 'HEAD');
  const done = merge(ctx.repo, 7);
  ok('recover: the retry merges once the conflict is gone', done.json.status === 'merged' && done.json.method === 'merge');
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'a.txt', 'slot\n');
  commitFile(ctx.repo, 'a.txt', 'trunk\n', 'feat: trunk edits a');
  spawnSync('git', ['-C', ctx.repo, 'merge', '--no-edit', 'trailhead/t7'], { encoding: 'utf8' });
  ok('recover setup: a human merge is in progress', fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')));
  const r = recover(ctx.repo);
  ok('recover: a foreign merge is reported and left alone', r.code === 0 && r.json.status === 'foreign' && fs.existsSync(gitPath(ctx.repo, 'MERGE_HEAD')));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  fs.mkdirSync(gitPath(ctx.repo, 'rebase-merge'), { recursive: true });
  ok('recover: a rebase is foreign', recover(ctx.repo).json.status === 'foreign');
  cleanup(ctx);
}

// --- crash window after a landed merge -----------------------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  commitFile(ctx.repo, 'c.txt', 'c\n', 'feat: trunk moved');
  merge(ctx.repo, 7); // the merge landed, then the orchestrator "crashed" before resolving
  ok('crash window: recover finds nothing to do', recover(ctx.repo).json.status === 'clean');
  ok('crash window: merge answers already-merged', merge(ctx.repo, 7).json.status === 'already-merged');
  cleanup(ctx);
}

// --- remove -------------------------------------------------------------------------------------
{
  const ctx = makeRepo();
  const wt = makeSlot(ctx, 7, 'b.txt', 'b\n');
  const early = remove(ctx.repo, 7);
  ok('remove: not-merged refuses an unmerged branch', early.code === 0 && early.json.status === 'not-merged' && fs.existsSync(wt) && gitOk(ctx.repo, 'rev-parse', '--verify', '-q', 'trailhead/t7'));
  merge(ctx.repo, 7);
  write(path.join(wt, '.trailhead', 'work-state.json'), '{}\n');
  const r = remove(ctx.repo, 7);
  ok('remove: a merged worktree slot is removed with its branch', r.code === 0 && r.json.status === 'removed' && r.json.worktreeRemoved === true && r.json.branchDeleted === true);
  ok('remove: the workspace and branch are gone', !fs.existsSync(wt) && !gitOk(ctx.repo, 'rev-parse', '--verify', '-q', 'trailhead/t7'));
  const again = remove(ctx.repo, 7);
  ok('remove: a retry is idempotent', again.code === 0 && again.json.status === 'removed' && again.json.worktreeRemoved === false && again.json.branchDeleted === false);
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  const wt = makeSlot(ctx, 7, 'b.txt', 'b\n');
  merge(ctx.repo, 7);
  git(ctx.repo, 'worktree', 'remove', wt); // a partial remove: worktree gone, branch left
  const r = remove(ctx.repo, 7);
  ok('remove: a retry after a partial remove finishes the branch', r.json.status === 'removed' && r.json.worktreeRemoved === false && r.json.branchDeleted === true && !gitOk(ctx.repo, 'rev-parse', '--verify', '-q', 'trailhead/t7'));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  const wt = makeSlot(ctx, 7, 'b.txt', 'b\n');
  merge(ctx.repo, 7);
  write(path.join(wt, 'untracked-work.txt'), 'precious\n');
  const r = remove(ctx.repo, 7);
  ok('remove: a dirty workspace is an error and is kept', r.code === 1 && r.json.status === 'error' && fs.existsSync(path.join(wt, 'untracked-work.txt')) && gitOk(ctx.repo, 'rev-parse', '--verify', '-q', 'trailhead/t7'));
  cleanup(ctx);
}
{
  const ctx = makeRepo();
  const clone = path.join(ctx.parent, 'repo-t5');
  git(ctx.parent, 'clone', '-q', ctx.repo, clone);
  git(clone, 'checkout', '-q', '-b', 'trailhead/t5');
  const r = remove(ctx.repo, 5);
  ok('remove: a clone slot is kept, never deleted', r.code === 0 && r.json.status === 'kept' && fs.existsSync(path.join(clone, '.git')));
  cleanup(ctx);
}

// --- usage errors ---------------------------------------------------------------------------------
for (const [name, argv] of [
  ['no subcommand', []],
  ['unknown subcommand', ['frobnicate']],
  ['merge without --repo', ['merge', '--ticket', '7']],
  ['merge without --ticket', ['merge', '--repo', '/x']],
  ['bad --ticket', ['merge', '--repo', '/x', '--ticket', 'x']],
  ['recover with --ticket', ['recover', '--repo', '/x', '--ticket', '7']],
  ['unknown flag', ['merge', '--repo', '/x', '--ticket', '7', '--force']],
  ['flag without value', ['remove', '--repo']],
]) {
  const r = run(argv);
  ok(`usage: ${name} exits 2 with stderr`, r.code === 2 && r.errOut.startsWith('usage:') && r.out === '');
}

// --- end-to-end -------------------------------------------------------------------------------------
{
  const ctx = makeRepo();
  makeSlot(ctx, 7, 'b.txt', 'b\n');
  const p = spawnSync('node', [scriptPath, 'merge', '--repo', ctx.repo, '--ticket', '7'], { encoding: 'utf8' });
  let j = null;
  try { j = JSON.parse(p.stdout.trim()); } catch { /* not json */ }
  ok('e2e: the script merges and prints one JSON line', p.status === 0 && j && j.status === 'merged' && p.stdout.trim().split('\n').length === 1);
  const bad = spawnSync('node', [scriptPath], { encoding: 'utf8' });
  ok('e2e: a usage error exits 2', bad.status === 2);
  cleanup(ctx);
}

console.log(`auto-merge.test.js: ${passed} checks passed`);
