#!/usr/bin/env node
// Tests for templates/trailhead-auto-slot.js. Run: node auto-slot.test.js
// No framework: plain asserts, same style as auto-queue.test.js.
//
// Layers covered:
//   1. main() open / list against REAL temporary git repos (the default git runner).
//   2. Usage errors (exit 2).
//   3. End-to-end: the script itself through spawnSync.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptPath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-auto-slot.js');
const { main } = require(scriptPath);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

// A parent dir holding <parent>/repo with two commits. Returns { parent, repo, first, second }.
function makeRepo() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-slot-')));
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  const first = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-q', '-am', 'second');
  const second = git(repo, 'rev-parse', 'HEAD');
  return { parent, repo, first, second };
}

function run(argv, deps = {}) {
  let out = '';
  let errOut = '';
  const code = main(argv, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { errOut += s; } }, ...deps });
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* not json */ }
  return { code, out, json, errOut };
}

const open = (repo, n, base, deps) => run(['open', '--repo', repo, '--ticket', String(n), '--base', base], deps);
const list = (repo, deps) => run(['list', '--repo', repo], deps);

// --- open: created -----------------------------------------------------------
{
  const { parent, repo, first, second } = makeRepo();
  const r = open(repo, 7, first);
  const wt = path.join(parent, 'repo-t7');
  ok('open: created exits 0', r.code === 0);
  ok('open: created status, ticket, branch, path', r.json.status === 'created' && r.json.ticket === 7 && r.json.branch === 'trailhead/t7' && r.json.path === wt);
  ok('open: the worktree directory exists', fs.existsSync(path.join(wt, 'a.txt')));
  ok('open: branch points exactly at --base', git(repo, 'rev-parse', 'refs/heads/trailhead/t7') === first);
  ok('open: branch is not the repo HEAD', git(repo, 'rev-parse', 'refs/heads/trailhead/t7') !== second && git(repo, 'rev-parse', 'HEAD') === second);
  ok('open: worktree checked out on the branch', git(wt, 'rev-parse', '--abbrev-ref', 'HEAD') === 'trailhead/t7');

  // reentered: same call again, nothing new created
  const again = open(repo, 7, second);
  ok('open: reentered when the branch is already checked out there', again.code === 0 && again.json.status === 'reentered' && again.json.path === wt);
  ok('open: reentered does not move the branch', git(repo, 'rev-parse', 'refs/heads/trailhead/t7') === first);

  // reattached: worktree removed, branch kept
  git(repo, 'worktree', 'remove', '--force', wt);
  const re = open(repo, 7, second);
  ok('open: reattached when the branch exists without a worktree', re.code === 0 && re.json.status === 'reattached' && re.json.path === wt);
  ok('open: reattached keeps the branch commit', git(repo, 'rev-parse', 'refs/heads/trailhead/t7') === first && git(wt, 'rev-parse', 'HEAD') === first);
  fs.rmSync(parent, { recursive: true, force: true });
}

// --- open: branch checked out at another path -> reentered with that path ---
{
  const { parent, repo, first } = makeRepo();
  const other = path.join(parent, 'elsewhere');
  git(repo, 'worktree', 'add', '-q', '-b', 'trailhead/t9', other, first);
  const r = open(repo, 9, first);
  ok('open: a hand-made worktree elsewhere is reentered with its path', r.code === 0 && r.json.status === 'reentered' && r.json.path === other);
  ok('open: nothing created at the sibling path', !fs.existsSync(path.join(parent, 'repo-t9')));
  fs.rmSync(parent, { recursive: true, force: true });
}

// --- open: path collision ----------------------------------------------------
{
  const { parent, repo, first } = makeRepo();
  const target = path.join(parent, 'repo-t3');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'mine\n');
  const r = open(repo, 3, first);
  ok('open: existing path is an error', r.code === 1 && r.json.status === 'error' && /exist/.test(r.json.reason));
  ok('open: existing path is never overwritten', fs.readFileSync(path.join(target, 'keep.txt'), 'utf8') === 'mine\n');
  ok('open: no branch created on a path collision', spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/trailhead/t3']).status !== 0);

  // reattach into an occupied path is an error too
  git(repo, 'branch', 'trailhead/t4', first);
  fs.mkdirSync(path.join(parent, 'repo-t4'));
  const r4 = open(repo, 4, first);
  ok('open: reattach onto an existing path is an error', r4.code === 1 && r4.json.status === 'error');
  fs.rmSync(parent, { recursive: true, force: true });
}

// --- open: invalid base ------------------------------------------------------
{
  const { parent, repo } = makeRepo();
  const r = open(repo, 5, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  ok('open: unresolvable base is an error', r.code === 1 && r.json.status === 'error' && /base/.test(r.json.reason));
  ok('open: nothing created for an invalid base', !fs.existsSync(path.join(parent, 'repo-t5')));
  fs.rmSync(parent, { recursive: true, force: true });
}

// --- open: clone-required on a superrepo -------------------------------------
{
  const { parent, repo, first } = makeRepo();
  fs.writeFileSync(path.join(repo, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://example.com/lib.git\n');
  const r = open(repo, 8, first);
  ok('open: a declared submodule needs a clone', r.code === 0 && r.json.status === 'clone-required' && r.json.path === path.join(parent, 'repo-t8') && r.json.branch === 'trailhead/t8');
  ok('open: clone-required creates no worktree', !fs.existsSync(path.join(parent, 'repo-t8')));
  fs.writeFileSync(path.join(repo, '.gitmodules'), '# nothing declared\n');
  const none = open(repo, 8, first);
  ok('open: a .gitmodules without a submodule section does not force a clone', none.json.status === 'created');
  fs.rmSync(parent, { recursive: true, force: true });
}

// --- list --------------------------------------------------------------------
{
  const { parent, repo, first, second } = makeRepo();
  ok('list: a repo with no slot is empty', list(repo).json.slots.length === 0);

  open(repo, 12, first);
  open(repo, 4, second);
  // worktree on a non-slot branch is not a slot
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', path.join(parent, 'feature-x'), first);

  // a sibling clone on trailhead/t21
  const clone = path.join(parent, 'repo-t21');
  git(parent, 'clone', '-q', repo, clone);
  git(clone, 'config', 'user.name', 'T');
  git(clone, 'config', 'user.email', 't@example.com');
  git(clone, 'checkout', '-q', '-b', 'trailhead/t21', first);
  // a sibling clone on the wrong branch is ignored
  const wrong = path.join(parent, 'repo-t22');
  git(parent, 'clone', '-q', repo, wrong);
  git(wrong, 'checkout', '-q', '-b', 'trailhead/t99');
  // a sibling dir that is not a git checkout is ignored
  fs.mkdirSync(path.join(parent, 'repo-t30'));
  // a sibling dir inside another checkout (no own git dir) is ignored
  fs.mkdirSync(path.join(repo, 'repo-t31'));

  const wt12 = path.join(parent, 'repo-t12');
  const wt4 = path.join(parent, 'repo-t4');
  // work state: present on t12, unparseable on t4, absent on the clone
  fs.mkdirSync(path.join(wt12, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(wt12, '.trailhead', 'work-state.json'), JSON.stringify({ ticket: 12, auto: true }));
  fs.mkdirSync(path.join(wt4, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(wt4, '.trailhead', 'work-state.json'), '{not json');
  // dirty: t12 has an untracked file (.trailhead is untracked too, so both worktrees are dirty); clone is clean
  fs.writeFileSync(path.join(wt12, 'new.txt'), 'x\n');

  const r = list(repo);
  ok('list: exits 0 with status ok', r.code === 0 && r.json.status === 'ok');
  ok('list: slots sorted by ticket', JSON.stringify(r.json.slots.map((s) => s.ticket)) === JSON.stringify([4, 12, 21]));
  const by = Object.fromEntries(r.json.slots.map((s) => [s.ticket, s]));
  ok('list: worktree kind, branch and path', by[12].kind === 'worktree' && by[12].branch === 'trailhead/t12' && by[12].path === wt12);
  ok('list: sibling clone is listed as clone', by[21].kind === 'clone' && by[21].branch === 'trailhead/t21' && by[21].path === clone);
  ok('list: non-slot worktree, wrong-branch clone, non-git dir and nested dir are ignored', !r.json.slots.some((s) => [99, 30, 31].includes(s.ticket)) && r.json.slots.length === 3);
  ok('list: work state present is parsed', by[12].workState && by[12].workState.ticket === 12 && by[12].workState.auto === true);
  ok('list: work state absent is null without a warning', by[21].workState === null && !r.json.warnings.some((w) => w.includes('repo-t21')));
  ok('list: unparseable work state is null plus a warning', by[4].workState === null && r.json.warnings.length === 1 && r.json.warnings[0].includes('repo-t4'));
  ok('list: dirty detected', by[12].dirty === true);
  ok('list: a clean checkout is not dirty', by[21].dirty === false);
  fs.rmSync(parent, { recursive: true, force: true });
}

// --- list: a git failure on the main repo ------------------------------------
{
  const notRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-slot-nr-')));
  const r = list(notRepo);
  ok('list: git failing on the main repo is an error', r.code === 1 && r.json.status === 'error');
  fs.rmSync(notRepo, { recursive: true, force: true });
}

// --- injectable git runner ---------------------------------------------------
{
  const calls = [];
  const fake = (args) => { calls.push(args.join(' ')); return { status: 1, stdout: '', stderr: 'boom' }; };
  const r = list('/nowhere/repo', { git: fake });
  ok('seam: injected git runner is used and its failure is an error', r.code === 1 && r.json.status === 'error' && calls.length >= 1 && calls[0].startsWith('-C /nowhere/repo'));
}

// --- usage errors ------------------------------------------------------------
{
  const u = (argv) => run(argv);
  ok('usage: no command exits 2', u([]).code === 2);
  ok('usage: unknown command exits 2', u(['remove', '--repo', '/x']).code === 2);
  ok('usage: open without --ticket exits 2', u(['open', '--repo', '/x', '--base', 'abc']).code === 2);
  ok('usage: open without --base exits 2', u(['open', '--repo', '/x', '--ticket', '3']).code === 2);
  ok('usage: open without --repo exits 2', u(['open', '--ticket', '3', '--base', 'abc']).code === 2);
  ok('usage: bad --ticket exits 2', u(['open', '--repo', '/x', '--ticket', 'x', '--base', 'abc']).code === 2);
  ok('usage: list without --repo exits 2', u(['list']).code === 2);
  ok('usage: unknown flag exits 2', u(['list', '--repo', '/x', '--bogus', '1']).code === 2);
  ok('usage: errors go to stderr, stdout stays empty', u(['open']).errOut.startsWith('usage:') && u(['open']).out === '');
}

// --- end-to-end --------------------------------------------------------------
{
  const { parent, repo, first } = makeRepo();
  const res = spawnSync('node', [scriptPath, 'open', '--repo', repo, '--ticket', '15', '--base', first], { encoding: 'utf8' });
  const j = JSON.parse(res.stdout.trim());
  ok('e2e: open prints one JSON line and exits 0', res.status === 0 && j.status === 'created' && j.path === path.join(parent, 'repo-t15'));
  const ls = spawnSync('node', [scriptPath, 'list', '--repo', repo], { encoding: 'utf8' });
  const lj = JSON.parse(ls.stdout.trim());
  ok('e2e: list finds the new slot', ls.status === 0 && lj.slots.length === 1 && lj.slots[0].ticket === 15);
  ok('e2e: usage error exits 2', spawnSync('node', [scriptPath, '--bogus'], { encoding: 'utf8' }).status === 2);
  fs.rmSync(parent, { recursive: true, force: true });
}

console.log(`auto-slot.test.js: ${passed} checks passed`);
