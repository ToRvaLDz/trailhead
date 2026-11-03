#!/usr/bin/env node
'use strict';
// trailhead repo target (self-contained, ships in templates/ so it reaches every
// install channel: bin/trailhead.js copies templates/ wholesale for Claude/npm and
// Codex). Verifies which repository `gh` will write issues to, once per session,
// before the first tracker write. #351.
//
// Why: in a fork clone `gh` ranks a parent remote (`upstream`) above `origin`, or
// honours `remote.<parent>.gh-resolved=base` (set by `gh repo fork` / `gh repo
// set-default`), so a bare `gh issue ...` or `gh api repos/{owner}/{repo}/...` can
// land on the parent. Seen from the resolved target the parent reports
// isFork:false, so the fork relation is read from the `origin` side: origin is a
// fork whose parent equals the resolved target.
//
// CLI:
//   node trailhead-repo-target.js check  [--repo <dir>]
//   node trailhead-repo-target.js record [--repo <dir>] --target <owner/name>
//   node trailhead-repo-target.js clear  [--repo <dir>]
// --repo defaults to cwd; canonicalised to the project root (main worktree via the
// git common dir) like trailhead-isolation-answer.js, so a linked worktree shares
// the record.
// File shape (<project root>/.trailhead/repo-target.json): { target, recordedAt, usedAt }
// A session is an 8-hour sliding idle window (each reuse refreshes usedAt); a
// malformed or future timestamp is invalid and the target is checked again.
// check prints one JSON line:
//   {"status":"ok","target"}                       plain repo, or a writable own fork: proceed silently
//   {"status":"reuse","target","recordedAt","path"}  a recorded answer for this very target (usedAt refreshed)
//   {"status":"ask","reason":"fork-parent|no-write","target","candidates":[...],"path"}
//   {"status":"skipped","reason"}                  gh/git unavailable or any error: proceed as before
// record validates the slug, runs `gh repo set-default <target>` when it differs
// from the current resolution (so every later bare gh call lands there), then writes
// the file: {"status":"written","target","setDefault":true|false,"path"}; if
// set-default fails: {"status":"error","reason"} and nothing is written.
// clear prints {"status":"cleared|absent","path"}.
// Exit 0 on every normal outcome and on any unexpected error; exit 2 only on a
// usage error (nothing is written).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { gitEnv } = require('./trailhead-git-env.js');

const STATE_DIR = '.trailhead';
const STATE_FILE = 'repo-target.json';
const IDLE_WINDOW_MS = 8 * 60 * 60 * 1000;
const WRITE_PERMISSIONS = ['ADMIN', 'MAINTAIN', 'WRITE'];
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const sameSlug = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// "owner/name" of a GitHub remote URL (https, scp-like ssh, ssh://), else null.
function parseGithubSlug(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|[^/@\s]+@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Strict ISO-8601 timestamp (as written by toISOString) -> epoch ms, or null.
function parseTime(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

// Valid record or null (not an object, bad slug, malformed or future timestamp).
function validateRecord(raw, nowMs) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.target !== 'string' || !SLUG_RE.test(raw.target)) return null;
  const recordedAt = parseTime(raw.recordedAt);
  const usedAt = parseTime(raw.usedAt);
  if (recordedAt === null || usedAt === null || recordedAt > nowMs || usedAt > nowMs) return null;
  return { target: raw.target, recordedAt: raw.recordedAt, usedAt };
}

// Slug of the parent in a `gh repo view --json parent` value, or null.
function parentSlug(parent) {
  if (!parent || typeof parent !== 'object') return null;
  if (typeof parent.nameWithOwner === 'string') return parent.nameWithOwner;
  const owner = parent.owner && typeof parent.owner === 'object' ? parent.owner.login : parent.owner;
  return typeof owner === 'string' && typeof parent.name === 'string' ? `${owner}/${parent.name}` : null;
}

// Pure decision. facts: { target, permission, originSlug, originInfo, remotes }
//   originInfo: parsed `gh repo view <origin>` ({isFork, parent}) or null; remotes: GitHub slugs, origin first.
// record: parsed file content (null/undefined = absent).
function decide(facts, record, now) {
  const { target, permission, originSlug, originInfo, remotes } = facts;
  const valid = record === null || record === undefined ? null : validateRecord(record, now.getTime());
  if (valid && now.getTime() - valid.usedAt <= IDLE_WINDOW_MS && sameSlug(valid.target, target)) {
    return { status: 'reuse', target, recordedAt: valid.recordedAt };
  }
  const parent = originInfo && originInfo.isFork === true ? parentSlug(originInfo.parent) : null;
  if (originSlug && parent && sameSlug(parent, target) && !sameSlug(originSlug, target)) {
    return { status: 'ask', reason: 'fork-parent', target, candidates: [originSlug, target] };
  }
  if (typeof permission === 'string' && !WRITE_PERMISSIONS.includes(permission)) {
    const others = (remotes || []).filter((s) => !sameSlug(s, target));
    const candidates = [...new Set([...others, target])];
    return { status: 'ask', reason: 'no-write', target, candidates };
  }
  return { status: 'ok', target };
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== 'check' && command !== 'record' && command !== 'clear') {
    return { error: `usage: expected "check", "record" or "clear", got: ${command === undefined ? '(nothing)' : command}` };
  }
  const allowed = command === 'record' ? ['--repo', '--target'] : ['--repo'];
  let repo = null;
  let target;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    if (flag === '--repo') repo = argv[i];
    else if (!SLUG_RE.test(argv[i])) return { error: `usage: --target must be owner/name, got: ${argv[i]}` };
    else target = argv[i];
  }
  if (command === 'record' && target === undefined) return { error: 'usage: record needs --target' };
  return { command, repo, target };
}

// Project root: the main worktree when dir is inside a linked worktree, else dir.
function resolveProjectRoot(dir) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }).trim();
    if (common && path.basename(common) === '.git') return path.dirname(common);
    return dir;
  } catch {
    return dir;
  }
}

// Default runner: run(cmd, args, { cwd }) -> { status, stdout, stderr } (status null when the binary is missing).
function defaultRun(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function ghJson(run, args, cwd) {
  const r = run('gh', args, { cwd });
  if (!r || r.status !== 0) return null;
  try {
    const v = JSON.parse(r.stdout);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// GitHub slugs of the clone's remotes, origin first, deduplicated.
function remoteSlugs(run, cwd) {
  const r = run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd });
  if (!r || r.status !== 0) return { origin: null, all: [] };
  let origin = null;
  const all = [];
  for (const line of String(r.stdout).split('\n')) {
    const m = line.match(/^remote\.(.+)\.url\s+(.+)$/);
    const slug = m ? parseGithubSlug(m[2]) : null;
    if (!slug) continue;
    if (m[1] === 'origin') origin = slug;
    all.push({ name: m[1], slug });
  }
  all.sort((a, b) => (a.name === 'origin' ? -1 : 0) - (b.name === 'origin' ? -1 : 0));
  return { origin, all: [...new Set(all.map((x) => x.slug))] };
}

function readRecord(file, fsMod) {
  let text;
  try {
    text = fsMod.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Atomic write: a unique temp in the same dir, then rename over the file.
function writeAtomic(dir, file, text, fsMod) {
  fsMod.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${STATE_FILE}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fsMod.writeFileSync(tmp, text);
    fsMod.renameSync(tmp, file);
  } catch (err) {
    try { fsMod.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

const writeResult = (stdout, result) => stdout.write(JSON.stringify(result) + '\n');

function doCheck({ repoDir, file, dir, run, fsMod, now, out }) {
  const view = ghJson(run, ['repo', 'view', '--json', 'nameWithOwner,viewerPermission'], repoDir);
  if (!view || typeof view.nameWithOwner !== 'string') {
    writeResult(out, { status: 'skipped', reason: 'gh could not resolve a target repository' });
    return;
  }
  const target = view.nameWithOwner;
  const { origin, all } = remoteSlugs(run, repoDir);
  const originInfo = origin && !sameSlug(origin, target)
    ? ghJson(run, ['repo', 'view', origin, '--json', 'nameWithOwner,isFork,parent'], repoDir) : null;
  const raw = readRecord(file, fsMod);
  const decision = decide({ target, permission: view.viewerPermission, originSlug: origin, originInfo, remotes: all }, raw, now);
  if (decision.status === 'reuse') {
    // Slide the idle window first: reuse is only reported once it is persisted.
    writeAtomic(dir, file, JSON.stringify({ ...raw, usedAt: now.toISOString() }, null, 2) + '\n', fsMod);
    writeResult(out, { ...decision, path: file });
  } else {
    writeResult(out, decision.status === 'ask' ? { ...decision, path: file } : decision);
  }
}

function doRecord({ repoDir, file, dir, run, fsMod, now, out, target }) {
  const view = ghJson(run, ['repo', 'view', '--json', 'nameWithOwner'], repoDir);
  if (!view || typeof view.nameWithOwner !== 'string') {
    writeResult(out, { status: 'error', reason: 'gh could not resolve the current target repository' });
    return;
  }
  const needsDefault = !sameSlug(view.nameWithOwner, target);
  if (needsDefault) {
    const r = run('gh', ['repo', 'set-default', target], { cwd: repoDir });
    if (!r || r.status !== 0) {
      const detail = r && r.stderr ? String(r.stderr).trim().split('\n')[0] : 'exit ' + (r ? r.status : 'unknown');
      writeResult(out, { status: 'error', reason: `gh repo set-default ${target} failed: ${detail}` });
      return;
    }
  }
  const stamp = now.toISOString();
  writeAtomic(dir, file, JSON.stringify({ target, recordedAt: stamp, usedAt: stamp }, null, 2) + '\n', fsMod);
  writeResult(out, { status: 'written', target, setDefault: needsDefault, path: file });
}

function main(argv, { cwd, stdout, fs: fsMod, now, run } = {}) {
  const out = stdout || process.stdout;
  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }
  const repoDir = parsed.repo ? path.resolve(cwd || process.cwd(), parsed.repo) : (cwd || process.cwd());
  const root = resolveProjectRoot(repoDir);
  const dir = path.join(root, STATE_DIR);
  const file = path.join(dir, STATE_FILE);
  const ctx = { repoDir, file, dir, run: run || defaultRun, fsMod: fsMod || fs, now: now || new Date(), out, target: parsed.target };
  try {
    if (parsed.command === 'clear') {
      const present = ctx.fsMod.existsSync(file);
      if (present) ctx.fsMod.unlinkSync(file);
      writeResult(out, { status: present ? 'cleared' : 'absent', path: file });
    } else if (parsed.command === 'record') {
      doRecord(ctx);
    } else {
      doCheck(ctx);
    }
  } catch (err) {
    writeResult(out, { status: 'skipped', reason: 'error: ' + (err && err.message ? err.message : String(err)) });
  }
  return 0;
}

module.exports = { IDLE_WINDOW_MS, parseGithubSlug, parentSlug, decide, parseArgs, resolveProjectRoot, main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout }));
}
