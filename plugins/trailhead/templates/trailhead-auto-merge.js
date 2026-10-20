#!/usr/bin/env node
'use strict';
// trailhead auto-merge helper (self-contained, ships in templates/ so it reaches every
// install channel). Merges a verified slot branch of an autonomous run into the local
// trunk (never a push), recovers an interrupted merge, and removes a merged slot. #286.
//
// CLI (every command runs against the MAIN checkout, which is on the trunk):
//   node trailhead-auto-merge.js merge   --repo <main-checkout> --ticket <n> [--trunk <name>]
//   node trailhead-auto-merge.js recover --repo <main-checkout>
//   node trailhead-auto-merge.js remove  --repo <main-checkout> --ticket <n> [--trunk <name>]
//
// Trunk: --trunk, else the remote default branch (refs/remotes/origin/HEAD), else the
// first existing of main / master (the base-preflight rule); none -> error.
// Every git-state path (MERGE_HEAD, MERGE_MSG, rebase-merge, ...) is resolved with
// `git rev-parse --git-path`, never assumed under .git/.
//
// merge: preconditions first, each a distinct status with nothing touched:
//   marker-mismatch  the main checkout's .trailhead/session-ticket names another ticket
//                    (the commit-msg hook would refuse the merge commit's Refs trailer;
//                    the marker is never written or rewritten here)
//   not-on-trunk     HEAD of the main checkout is not refs/heads/<trunk>
//   in-progress      a merge / rebase / cherry-pick is already under way (run recover)
//   dirty            tracked changes in the main checkout (untracked files are fine)
//   slot-dirty       the branch's slot worktree has uncommitted tracked work
//   error            the branch does not exist, or the trunk cannot be resolved
// Then: already-merged when the tip is an ancestor of the trunk (an idempotent retry);
// otherwise `git merge --no-edit -m "chore(auto): merge trailhead/t<n>" -m "Refs: #<n>"`
// (fast-forward when possible, else a merge commit that passes the commit-msg hook).
//   merged         method ff|merge, from (trunk before), head (trunk after)
//   conflict       conflicting paths in `conflicts`; the merge is aborted
//   merge-failed   any other failure (hook refusal, untracked file in the way); aborted
// An abort that does not leave HEAD at its pre-merge commit with a clean tracked tree
// falls back to `git reset --merge <pre>` (safe: the preconditions guarantee a clean
// tracked tree); only when that fails too is the result error "main left mid-merge",
// the one case the caller must stop on. Never --force, never reset --hard.
// On merged / already-merged, `behind` lists every OTHER trailhead/t* worktree slot with
// trunk commits not in its branch ({ticket, path, behind}), informational.
//
// recover: no merge under way -> clean; a merge whose MERGE_MSG first line is
// "chore(auto): merge trailhead/t<n>" -> aborted (same abort / fallback), with `ticket`;
// anything else (a human's merge, a rebase, a cherry-pick) -> foreign, untouched.
//
// remove: only for a branch already merged into the trunk (else not-merged). A worktree
// slot is removed with `git worktree remove` (no --force: a dirty one is an error and
// stays) and the branch deleted with `git branch -d`; a clone slot is never deleted
// (kept). Idempotent: a worktree already gone or a branch already deleted is skipped.
// removed carries worktreeRemoved / branchDeleted (what THIS call did).
//
// One orchestrator runs merges one at a time. Two autonomous runs on the same main
// checkout are not supported (no lock file); the in-progress precondition keeps this
// helper from touching a merge it did not start.
//
// Prints exactly one JSON line on stdout: {"status":"...", ...}. Exit 0 whenever the
// status is a result (parked statuses included), 1 on status error, 2 on a usage error.

const { spawnSync } = require('child_process');
const nodeFs = require('fs');
const path = require('path');

function defaultGit(args) {
  const env = { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };
  const r = spawnSync('git', args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const branchOf = (n) => `trailhead/t${n}`;
const BRANCH_RE = /^refs\/heads\/trailhead\/t(\d+)$/;
const MERGE_SUBJECT = /^chore\(auto\): merge trailhead\/t(\d+)$/;
const IN_PROGRESS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'];

// --- args ---------------------------------------------------------------------

const FLAGS = { merge: ['--repo', '--ticket', '--trunk'], recover: ['--repo'], remove: ['--repo', '--ticket', '--trunk'] };

function parseArgs(argv) {
  const cmd = argv[0];
  if (!Object.prototype.hasOwnProperty.call(FLAGS, cmd)) return { error: `usage: expected merge, recover or remove, got: ${cmd === undefined ? '(nothing)' : cmd}` };
  const o = { cmd, repo: null, ticket: null, trunk: null };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!FLAGS[cmd].includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--ticket') {
      if (!/^[1-9]\d*$/.test(v)) return { error: `usage: --ticket must be a positive integer, got: ${v}` };
      o.ticket = Number(v);
    } else if (!v.trim()) {
      return { error: `usage: ${flag} requires a non-empty value` };
    } else if (flag === '--repo') {
      o.repo = v;
    } else {
      o.trunk = v;
    }
  }
  if (!o.repo) return { error: `usage: ${cmd} requires --repo` };
  if (cmd !== 'recover' && !o.ticket) return { error: `usage: ${cmd} requires --ticket` };
  return o;
}

// --- git helpers --------------------------------------------------------------

// [{ path, branch|null }] from `git worktree list --porcelain`, main checkout first.
function parseWorktrees(text) {
  const out = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    let wt = null;
    let branch = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length);
    }
    if (wt) out.push({ path: wt, branch });
  }
  return out;
}

const realOr = (fs, p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// Absolute path of a git-state file of the main checkout (via --git-path).
function statePath(ctx, name) {
  const r = ctx.G(['rev-parse', '--git-path', name]);
  return r.status === 0 && r.stdout.trim() ? path.resolve(ctx.main, r.stdout.trim()) : null;
}

const stateExists = (ctx, name) => { const p = statePath(ctx, name); return p !== null && ctx.fs.existsSync(p); };
const inProgress = (ctx) => IN_PROGRESS.filter((n) => stateExists(ctx, n));
const head = (ctx) => ctx.G(['rev-parse', 'HEAD']).stdout.trim();
const trackedDirty = (ctx, dir) => ctx.git(['-C', dir || ctx.main, 'status', '--porcelain', '--untracked-files=no']).stdout.trim() !== '';
const hasRef = (ctx, ref) => ctx.G(['rev-parse', '--verify', '--quiet', ref]).status === 0;
const isAncestor = (ctx, a, b) => ctx.G(['merge-base', '--is-ancestor', a, b]).status === 0;

// Trunk name per the base-preflight rule, or null.
function detectTrunk(ctx, requested) {
  if (requested) return requested;
  const h = ctx.G(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (h.status === 0 && h.stdout.trim().startsWith('origin/')) return h.stdout.trim().slice('origin/'.length);
  for (const name of ['main', 'master']) {
    if (hasRef(ctx, `refs/heads/${name}`) || hasRef(ctx, `refs/remotes/origin/${name}`)) return name;
  }
  return null;
}

// The main checkout's state is exactly the pre-merge one: HEAD at pre, no merge, clean tracked tree.
const settled = (ctx, pre) => head(ctx) === pre && !stateExists(ctx, 'MERGE_HEAD') && !trackedDirty(ctx);

// Puts the main checkout back at `pre`. Abort first, reset --merge as the fallback.
function undoMerge(ctx, pre) {
  if (stateExists(ctx, 'MERGE_HEAD')) ctx.G(['merge', '--abort']);
  if (settled(ctx, pre)) return true;
  ctx.G(['reset', '--merge', pre]);
  return settled(ctx, pre);
}

const stuck = (ctx, fail) => fail('main left mid-merge: the merge could not be aborted; resolve or abort it by hand in ' + ctx.main);

// Slot worktrees other than `ticket`, with trunk commits their branch lacks.
function behindList(ctx, trunk, ticket) {
  const wl = ctx.G(['worktree', 'list', '--porcelain']);
  if (wl.status !== 0) return [];
  const out = [];
  for (const w of parseWorktrees(wl.stdout)) {
    const m = w.branch && BRANCH_RE.exec(w.branch);
    if (!m || Number(m[1]) === ticket || realOr(ctx.fs, w.path) === ctx.main || !ctx.fs.existsSync(w.path)) continue;
    const c = ctx.G(['rev-list', '--count', `${branchOf(m[1])}..refs/heads/${trunk}`]);
    const n = Number(c.stdout.trim());
    if (c.status === 0 && Number.isInteger(n) && n > 0) out.push({ ticket: Number(m[1]), path: w.path, behind: n });
  }
  return out.sort((a, b) => a.ticket - b.ticket);
}

// The marker's ticket number, or null (absent, unreadable or unparseable: the hook ignores it too).
function markerTicket(ctx) {
  try {
    const raw = String(ctx.fs.readFileSync(path.join(ctx.main, '.trailhead', 'session-ticket'), 'utf8')).replace(/^\uFEFF/, '');
    const m = raw.split('\n')[0].replace(/\r$/, '').match(/^#([1-9]\d*)(?:\s|$)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

// --- merge --------------------------------------------------------------------

function mergeBranch(ctx, o) {
  const { fail, emit } = ctx;
  const branch = branchOf(o.ticket);
  const ref = `refs/heads/${branch}`;
  const trunk = detectTrunk(ctx, o.trunk);
  if (!trunk) return fail('no trunk found (no remote default branch, main or master); pass --trunk');
  if (!hasRef(ctx, `refs/heads/${trunk}`)) return fail(`trunk ${trunk} has no local branch`);
  const result = (status, extra) => { emit({ status, ticket: o.ticket, branch, trunk, ...extra }); return 0; };

  const marker = markerTicket(ctx);
  if (marker !== null && marker !== o.ticket) return result('marker-mismatch', { marker, reason: `the main checkout's .trailhead/session-ticket names #${marker}, not #${o.ticket}; the merge commit would be refused` });
  const sym = ctx.G(['symbolic-ref', '-q', 'HEAD']);
  if (sym.stdout.trim() !== `refs/heads/${trunk}`) return result('not-on-trunk', { reason: `the main checkout is on ${sym.stdout.trim() || 'a detached HEAD'}, not ${trunk}` });
  const busy = inProgress(ctx);
  if (busy.length) return result('in-progress', { reason: `${busy.join(', ')} present in the main checkout; run recover first` });
  if (trackedDirty(ctx)) return result('dirty', { reason: 'tracked changes in the main checkout' });
  if (!hasRef(ctx, ref)) return fail(`branch ${branch} does not exist`);

  const wl = ctx.G(['worktree', 'list', '--porcelain']);
  const slot = wl.status === 0 ? parseWorktrees(wl.stdout).find((w) => w.branch === ref && realOr(ctx.fs, w.path) !== ctx.main) : null;
  if (slot && ctx.fs.existsSync(slot.path) && trackedDirty(ctx, slot.path)) return result('slot-dirty', { path: slot.path, reason: `uncommitted tracked work in ${slot.path} would be left out of the merge` });

  if (isAncestor(ctx, ref, `refs/heads/${trunk}`)) return result('already-merged', { head: head(ctx), behind: behindList(ctx, trunk, o.ticket) });

  const pre = head(ctx);
  const m = ctx.G(['merge', '--no-edit', '-m', `chore(auto): merge ${branch}`, '-m', `Refs: #${o.ticket}`, branch]);
  if (m.status === 0) {
    if (!isAncestor(ctx, ref, 'HEAD')) return fail(`git merge reported success but ${branch} is not in the trunk`);
    const method = ctx.G(['rev-parse', '--verify', '--quiet', 'HEAD^2']).status === 0 ? 'merge' : 'ff';
    return result('merged', { method, from: pre, head: head(ctx), behind: behindList(ctx, trunk, o.ticket) });
  }

  const conflicts = ctx.G(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
  const reason = firstLine(m.stderr) || firstLine(m.stdout) || `git merge exited ${m.status}`;
  if (!undoMerge(ctx, pre)) return stuck(ctx, fail);
  if (conflicts.length > 0) return result('conflict', { conflicts });
  return result('merge-failed', { reason });
}

// --- recover ------------------------------------------------------------------

function recoverMerge(ctx) {
  const { fail, emit } = ctx;
  const busy = inProgress(ctx);
  if (!busy.length) { emit({ status: 'clean' }); return 0; }
  if (!busy.includes('MERGE_HEAD')) { emit({ status: 'foreign', reason: `${busy.join(', ')} in progress, not started by a run` }); return 0; }
  let msg = '';
  try { msg = String(ctx.fs.readFileSync(statePath(ctx, 'MERGE_MSG'), 'utf8')); } catch { /* unreadable: foreign */ }
  const m = MERGE_SUBJECT.exec(firstLine(msg).trim());
  if (!m) { emit({ status: 'foreign', reason: 'a merge not started by a run is in progress' }); return 0; }
  if (!undoMerge(ctx, head(ctx))) return stuck(ctx, fail);
  emit({ status: 'aborted', ticket: Number(m[1]), branch: branchOf(m[1]) });
  return 0;
}

// --- remove -------------------------------------------------------------------

// True when dir is an independent checkout (its git dir lives inside it) on `branch`.
function cloneOnBranch(ctx, dir, branch) {
  const g = ctx.git(['-C', dir, 'rev-parse', '--absolute-git-dir']);
  if (g.status !== 0) return false;
  const gitDir = realOr(ctx.fs, g.stdout.trim());
  const root = realOr(ctx.fs, dir);
  if (gitDir !== root && !gitDir.startsWith(root + path.sep)) return false;
  const b = ctx.git(['-C', dir, 'symbolic-ref', '--quiet', 'HEAD']);
  return b.status === 0 && b.stdout.trim() === `refs/heads/${branch}`;
}

function removeSlot(ctx, o) {
  const { fail, emit } = ctx;
  const branch = branchOf(o.ticket);
  const ref = `refs/heads/${branch}`;
  const trunk = detectTrunk(ctx, o.trunk);
  if (!trunk) return fail('no trunk found (no remote default branch, main or master); pass --trunk');
  if (!hasRef(ctx, `refs/heads/${trunk}`)) return fail(`trunk ${trunk} has no local branch`);

  const wl = ctx.G(['worktree', 'list', '--porcelain']);
  if (wl.status !== 0) return fail(`git worktree list failed: ${firstLine(wl.stderr) || 'exit ' + wl.status}`);
  const slot = parseWorktrees(wl.stdout).find((w) => w.branch === ref && realOr(ctx.fs, w.path) !== ctx.main);

  if (!slot) {
    const sibling = path.join(path.dirname(ctx.main), `${path.basename(ctx.main)}-t${o.ticket}`);
    if (ctx.fs.existsSync(sibling) && cloneOnBranch(ctx, sibling, branch)) { emit({ status: 'kept', ticket: o.ticket, kind: 'clone', path: sibling, reason: 'a clone slot is never deleted' }); return 0; }
  }

  const branchExists = hasRef(ctx, ref);
  if (branchExists && !isAncestor(ctx, ref, `refs/heads/${trunk}`)) {
    emit({ status: 'not-merged', ticket: o.ticket, branch, reason: `${branch} is not merged into ${trunk}; nothing removed` });
    return 0;
  }

  let worktreeRemoved = false;
  if (slot && ctx.fs.existsSync(slot.path)) {
    const rm = ctx.G(['worktree', 'remove', slot.path]);
    if (rm.status !== 0) return fail(`git worktree remove failed for ${slot.path}, kept: ${firstLine(rm.stderr) || 'exit ' + rm.status}`);
    worktreeRemoved = true;
  } else if (slot) {
    return fail(`stale worktree of ${branch}: ${slot.path} is gone from disk but git still lists it; run git worktree prune and retry`);
  }

  let branchDeleted = false;
  if (branchExists) {
    const d = ctx.G(['branch', '-d', branch]);
    if (d.status !== 0) return fail(`git branch -d ${branch} failed: ${firstLine(d.stderr) || 'exit ' + d.status}`);
    branchDeleted = true;
  }
  emit({ status: 'removed', ticket: o.ticket, branch, worktreeRemoved, branchDeleted });
  return 0;
}

function main(argv, { git, stdout, stderr, fs } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const fsx = fs || nodeFs;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason, extra) => { emit({ status: 'error', reason, ...extra }); return 1; };
  const run = git || defaultGit;
  const mainDir = realOr(fsx, o.repo);
  const ctx = { git: run, G: (args) => run(['-C', mainDir, ...args]), fs: fsx, main: mainDir, fail, emit };
  if (ctx.G(['rev-parse', '--git-dir']).status !== 0) return fail(`${o.repo} is not a git repository`);
  if (o.cmd === 'merge') return mergeBranch(ctx, o);
  if (o.cmd === 'recover') return recoverMerge(ctx);
  return removeSlot(ctx, o);
}

module.exports = { main, parseArgs, parseWorktrees };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
