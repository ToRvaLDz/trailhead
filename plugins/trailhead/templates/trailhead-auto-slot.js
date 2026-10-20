#!/usr/bin/env node
'use strict';
// trailhead auto-slot helper (self-contained, ships in templates/ so it reaches every
// install channel). Opens and lists the slot workspaces of an autonomous run with
// parallel slots: one workspace per ticket in flight, a worktree (or, on a superrepo,
// an independent clone) at a sibling path on its own branch. #283.
//
// CLI:
//   node trailhead-auto-slot.js open --repo <main-checkout> --ticket <n> --base <sha>
//   node trailhead-auto-slot.js list --repo <main-checkout>
//
// Layout: the workspace of ticket <n> is <parent of the main checkout>/<basename>-t<n>
// on the branch trailhead/t<n>.
//
// open (never overwrites anything, never removes anything):
//   - the branch is already checked out in a worktree (at the slot path or any other
//     path, e.g. one made by hand earlier): status "reentered" with that path;
//   - the branch exists but has no worktree: "reattached" (git worktree add <path> <branch>);
//   - neither: "created" (git worktree add -b <branch> <path> <base>), the branch pointing
//     exactly at --base (the trunk SHA captured at claim, so a moved main checkout never
//     changes it);
//   - the slot path already exists and is not that branch's worktree: "error";
//   - the main checkout declares a submodule (.gitmodules): "clone-required", nothing
//     created. The caller sets the clone up at the same path, then checks out the branch
//     at the same base, so a clone slot carries the same path, branch and base.
// list: every slot workspace, sorted by ticket: each worktree on a trailhead/t<n> branch,
//   plus each sibling <basename>-t<n> that is an independent git checkout on the branch
//   trailhead/t<n> and not already a worktree. Each entry:
//   {ticket, kind: "worktree"|"clone", branch, path, dirty, workState}
//   dirty is true when `git status --porcelain` is non-empty; workState is the parsed
//   <path>/.trailhead/work-state.json, or null (missing, or unreadable plus a warning).
//
// Prints exactly one JSON line on stdout:
//   open:  {"status":"created|reentered|reattached|clone-required","ticket":n,"branch":"...","path":"..."}
//   list:  {"status":"ok","slots":[...],"warnings":[...]}
//   error: {"status":"error","reason":"..."}
// Exit 0 on ok, 1 on an error, 2 on a usage error (stderr).

const { spawnSync } = require('child_process');
const nodeFs = require('fs');
const path = require('path');

function defaultGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const branchOf = (n) => `trailhead/t${n}`;
const BRANCH_RE = /^refs\/heads\/trailhead\/t(\d+)$/;

// --- args ---------------------------------------------------------------------

function parseArgs(argv) {
  const cmd = argv[0];
  if (cmd !== 'open' && cmd !== 'list') return { error: `usage: expected open or list, got: ${cmd === undefined ? '(nothing)' : cmd}` };
  const allowed = cmd === 'open' ? ['--repo', '--ticket', '--base'] : ['--repo'];
  const o = { cmd, repo: null, ticket: null, base: null };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
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
      o.base = v;
    }
  }
  if (!o.repo) return { error: `usage: ${cmd} requires --repo` };
  if (cmd === 'open' && !o.ticket) return { error: 'usage: open requires --ticket' };
  if (cmd === 'open' && !o.base) return { error: 'usage: open requires --base' };
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

function hasSubmodule(fs, main) {
  try {
    return /^\s*\[submodule\s/m.test(fs.readFileSync(path.join(main, '.gitmodules'), 'utf8'));
  } catch { return false; }
}

// --- open ---------------------------------------------------------------------

function openSlot(ctx, o) {
  const { git, fs, main, fail, emit } = ctx;
  const branch = branchOf(o.ticket);
  const target = path.join(path.dirname(main), `${path.basename(main)}-t${o.ticket}`);
  const result = (status, p) => { emit({ status, ticket: o.ticket, branch, path: p }); return 0; };

  const wl = git(['-C', o.repo, 'worktree', 'list', '--porcelain']);
  if (wl.status !== 0) return fail(`git worktree list failed: ${firstLine(wl.stderr) || 'exit ' + wl.status}`);
  const held = parseWorktrees(wl.stdout).find((w) => w.branch === `refs/heads/${branch}`);
  if (held) return result('reentered', held.path);

  if (hasSubmodule(fs, main)) return result('clone-required', target);

  if (fs.existsSync(target)) return fail(`slot path already exists and is not the worktree of ${branch}: ${target}`);

  const exists = git(['-C', o.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (exists.status === 0) {
    const add = git(['-C', o.repo, 'worktree', 'add', target, branch]);
    if (add.status !== 0) return fail(`git worktree add failed: ${firstLine(add.stderr) || 'exit ' + add.status}`);
    return result('reattached', target);
  }

  const base = git(['-C', o.repo, 'rev-parse', '--verify', '--quiet', `${o.base}^{commit}`]);
  if (base.status !== 0) return fail(`base does not resolve to a commit: ${o.base}`);
  const add = git(['-C', o.repo, 'worktree', 'add', '-b', branch, target, base.stdout.trim()]);
  if (add.status !== 0) return fail(`git worktree add failed: ${firstLine(add.stderr) || 'exit ' + add.status}`);
  return result('created', target);
}

// --- list ---------------------------------------------------------------------

// { workState, warning } for the checkout at dir.
function readWorkState(fs, dir) {
  const file = path.join(dir, '.trailhead', 'work-state.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { workState: null, warning: null };
    return { workState: null, warning: `unreadable work state at ${file}` };
  }
  try { return { workState: JSON.parse(raw), warning: null }; } catch {
    return { workState: null, warning: `unparseable work state at ${file}` };
  }
}

function isDirty(git, dir) {
  const r = git(['-C', dir, 'status', '--porcelain']);
  return r.status === 0 ? { dirty: r.stdout.trim() !== '', warning: null } : { dirty: null, warning: `git status failed at ${dir}` };
}

// True when dir is an independent checkout (its git dir lives inside it) on `branch`.
function cloneOnBranch(git, fs, dir, branch) {
  const g = git(['-C', dir, 'rev-parse', '--absolute-git-dir']);
  if (g.status !== 0) return false;
  const gitDir = realOr(fs, g.stdout.trim());
  const root = realOr(fs, dir);
  if (gitDir !== root && !gitDir.startsWith(root + path.sep)) return false;
  const b = git(['-C', dir, 'symbolic-ref', '--quiet', 'HEAD']);
  return b.status === 0 && b.stdout.trim() === `refs/heads/${branch}`;
}

function listSlots(ctx, o) {
  const { git, fs, main, fail, emit } = ctx;
  const wl = git(['-C', o.repo, 'worktree', 'list', '--porcelain']);
  if (wl.status !== 0) return fail(`git worktree list failed: ${firstLine(wl.stderr) || 'exit ' + wl.status}`);
  const entries = [];
  const seen = new Set();
  for (const w of parseWorktrees(wl.stdout)) {
    const m = w.branch && BRANCH_RE.exec(w.branch);
    if (!m || realOr(fs, w.path) === main) continue;
    seen.add(realOr(fs, w.path));
    entries.push({ ticket: Number(m[1]), kind: 'worktree', branch: branchOf(m[1]), path: w.path });
  }

  const parent = path.dirname(main);
  const re = new RegExp(`^${path.basename(main).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-t(\\d+)$`);
  let names = [];
  try { names = fs.readdirSync(parent); } catch { /* unreadable parent: no clones */ }
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const dir = path.join(parent, name);
    if (seen.has(realOr(fs, dir))) continue;
    if (!cloneOnBranch(git, fs, dir, branchOf(m[1]))) continue;
    entries.push({ ticket: Number(m[1]), kind: 'clone', branch: branchOf(m[1]), path: dir });
  }

  const warnings = [];
  const slots = entries.sort((a, b) => a.ticket - b.ticket).map((e) => {
    const d = isDirty(git, e.path);
    const s = readWorkState(fs, e.path);
    for (const w of [d.warning, s.warning]) if (w) warnings.push(w);
    return { ...e, dirty: d.dirty, workState: s.workState };
  });
  emit({ status: 'ok', slots, warnings });
  return 0;
}

function main(argv, { git, stdout, stderr, fs } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const fsx = fs || nodeFs;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason) => { emit({ status: 'error', reason }); return 1; };
  const ctx = { git: git || defaultGit, fs: fsx, main: realOr(fsx, o.repo), fail, emit };
  return o.cmd === 'open' ? openSlot(ctx, o) : listSlots(ctx, o);
}

module.exports = { main, parseArgs, parseWorktrees, hasSubmodule };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
