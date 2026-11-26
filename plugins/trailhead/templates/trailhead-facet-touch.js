#!/usr/bin/env node
'use strict';
// Codebase facet check for Resolve: which facets of the codebase map cite a file a
// ticket touched, and has each been patched or reasonably restamped.
//
//   check   --repo <dir> --ticket <n> --issue <codebase n> --floor <sha>
//           [--gh-repo <owner/name>] [--before <file>] [--comment-file <file>]
//   restamp --repo <dir> --ticket <n> --issue <codebase n> --facet <name> --stamp <sha>
//           --reason "<file>: <why>" [--gh-repo <owner/name>]
//
// Prints one JSON line. Exit 0 on success, 2 on a usage error, a fatal error or a
// refusal ({"error":...} / {"status":"error"|"refused",...}), 1 when the guarded write
// of `restamp` failed after the refusal checks passed. Self-contained: it ships with
// the other templates and reuses the audit walk's path helpers and the issue-body
// write guards, so no parsing or write logic is duplicated here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { gitEnv } = require('./trailhead-git-env.js');
const { sanitizeToken, citedTokens } = require('./trailhead-audit-walk.js');
const { facetsOf, applyOp, guardedWrite, readIssue, defaultGh } = require('./trailhead-issue-body.js');

const SHA_RE = /^[0-9a-f]{7,40}$/;
const STAMP_LINE_RE = /^_as of [0-9a-f]{7,40}_$/;

// A fatal or refused run: `status` is the JSON status, always exit 2.
class Fail extends Error {
  constructor(message, status = 'error') { super(message); this.status = status; }
}

// --- git ----------------------------------------------------------------------------
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
}

function gitOk(repo, args) {
  try { git(repo, args); return true; } catch { return false; }
}

// The full commit sha of a hex rev, or null when it is unknown or ambiguous.
function resolveCommit(repo, rev) {
  if (!SHA_RE.test(String(rev))) return null;
  try {
    const full = git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]).trim();
    return /^[0-9a-f]{40}$/.test(full) ? full : null;
  } catch {
    return null;
  }
}

// The ticket's commits: exactly the Ticket diff command (anchored Refs trailer line).
function commitsOf(repo, ticket) {
  const out = git(repo, ['log', '--reverse', '--basic-regexp', `--grep=^Refs: #${ticket}$`, '--format=%H', 'HEAD']);
  return out.split('\n').filter(Boolean);
}

// Union of the files each commit changed (a merge against its remerge): a rename lists
// both sides, a deletion its old path.
function touchedOf(repo, shas) {
  const all = new Set();
  for (const sha of shas) {
    const out = git(repo, ['show', '--remerge-diff', '--format=', '--name-only', '-z', '--no-renames', sha]);
    for (const p of out.split('\0')) if (p) all.add(p);
  }
  return [...all].sort();
}

// --- facets ---------------------------------------------------------------------------
// A facet's cited paths: its `Cites:` line (sanitised), or, legacy, every backticked token.
function citedPaths(facet) {
  if (facet.cites === null) return citedTokens(facet.text);
  const out = [];
  for (const raw of facet.cites) {
    const t = sanitizeToken(raw);
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out;
}

// The touched files a facet cites (a cited directory counts its touched files).
function touchedCites(paths, touched) {
  const hit = new Set();
  for (const p of paths) {
    for (const f of touched) if (f === p || f.startsWith(p + '/')) hit.add(f);
  }
  return [...hit].sort();
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Hash of a facet's text without its stamp line (and the one blank line after it), so a
// stamp-only move never changes it.
function textHash(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (lines.length && STAMP_LINE_RE.test(lines[0].trim())) lines.splice(0, lines.length > 1 && lines[1].trim() === '' ? 2 : 1);
  return sha256(lines.join('\n').trim());
}

function assertUniqueNames(facets) {
  const seen = new Set();
  for (const f of facets) {
    if (seen.has(f.name)) throw new Fail(`duplicate facet name "${f.name}": the section writes pick the first match, fix the codebase body first`);
    seen.add(f.name);
  }
}

// Per-facet facts against the ticket: flagged cites, coverage by the floor, text hash.
function describeFacets(ctx, facets) {
  const { repo, touched, floor } = ctx;
  return facets.map((f) => {
    const paths = citedPaths(f);
    const info = { name: f.name, stamp: f.sha, covered: false, cites: touchedCites(paths, touched), textHash: textHash(f.text), uncheckable: null };
    if (!f.sha) { info.uncheckable = 'unstamped'; return info; }
    const live = paths.filter((p) => touched.some((t) => t === p || t.startsWith(p + '/')) || gitOk(repo, ['cat-file', '-e', `HEAD:${p}`]));
    if (!live.length) info.uncheckable = 'no-paths';
    const stamp = resolveCommit(repo, f.sha);
    info.covered = stamp !== null && gitOk(repo, ['merge-base', '--is-ancestor', floor, stamp]);
    return info;
  });
}

// --- comment lines ----------------------------------------------------------------------
// The single `Codebase:` line of a facet in the comment, as { kind } or { problem }.
function lineFor(lines, name, allowedFiles) {
  const prefix = `Codebase: ${name} `;
  const mine = lines.filter((l) => l === `${prefix}patched` || l.startsWith(`${prefix}restamped`));
  if (mine.length === 0) return { problem: 'no `Codebase:` line' };
  if (mine.length > 1) return { problem: 'more than one `Codebase:` line' };
  if (mine[0] === `${prefix}patched`) return { kind: 'patched' };
  const m = /^restamped, no change \(([^:]+): (.*)\)$/.exec(mine[0].slice(prefix.length));
  if (!m || m[2].trim() === '') return { problem: 'malformed restamped line, expected `restamped, no change (<file>: <why>)` with a reason' };
  if (!allowedFiles.includes(m[1].trim())) return { problem: `restamped file ${m[1].trim()} is not a touched file this facet cites` };
  return { kind: 'restamped' };
}

// The disposition a change proves, or null when there is no snapshot to compare with.
function requiredKind(live, before, hasBefore) {
  if (!hasBefore) return null;
  if (!live || !before) return 'patched';
  return live.textHash !== before.textHash ? 'patched' : 'restamped';
}

function judge(name, live, before, commentLines, hasBefore) {
  const problems = [];
  const lineProblems = [];
  if (live && !live.covered) problems.push('stamp does not cover the floor');
  const required = requiredKind(live, before, hasBefore);
  if (commentLines) {
    const r = lineFor(commentLines, name, live ? live.cites : []);
    const bad = r.problem || (required && r.kind !== required ? `needs a ${required} line for this change, got ${r.kind}` : null);
    if (bad) { problems.push(bad); lineProblems.push({ facet: name, problem: bad }); }
  }
  return { problems, lineProblems };
}

// --- check -------------------------------------------------------------------------------
function readSnapshot(file, ticket, floor, commits) {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Fail(`cannot read --before ${file}: ${e.message}`); }
  if (!snap || snap.status !== 'ok' || !Array.isArray(snap.flagged)) throw new Fail(`--before ${file} is not a check result`);
  if (snap.ticket !== ticket || snap.floor !== floor || JSON.stringify(snap.commits) !== JSON.stringify(commits)) {
    throw new Fail('--before was taken for another ticket, commit set or floor: run check again');
  }
  return snap.flagged;
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\r$/, '').trimEnd()); } catch (e) { throw new Fail(`cannot read --comment-file ${file}: ${e.message}`); }
}

function context(o) {
  const floor = resolveCommit(o.repo, o.floor);
  if (!floor) throw new Fail(`--floor ${o.floor} is not a known commit sha`);
  const commits = commitsOf(o.repo, o.ticket);
  if (!commits.length) throw new Fail(`no commit carries "Refs: #${o.ticket}": nothing to check against`);
  return { repo: o.repo, floor, commits, touched: touchedOf(o.repo, commits) };
}

function check(o, io) {
  const ctx = context(o);
  const read = readIssue(o.issue, { gh: io.gh, repo: o.ghRepo });
  if (read.error) throw new Fail(read.error);
  const facets = facetsOf(read.body);
  assertUniqueNames(facets);
  const infos = describeFacets(ctx, facets);
  const flagged = infos.filter((i) => !i.uncheckable && i.cites.length);
  const uncheckable = infos.filter((i) => i.uncheckable).map((i) => ({ name: i.name, reason: i.uncheckable }));
  const before = o.before ? readSnapshot(o.before, o.ticket, ctx.floor, ctx.commits) : null;
  const commentLines = o.commentFile ? readLines(o.commentFile) : null;
  const liveBy = new Map(infos.map((i) => [i.name, i]));
  const beforeBy = new Map((before || []).map((b) => [b.name, b]));
  const judged = [...new Set([...beforeBy.keys(), ...flagged.map((f) => f.name)])];
  const pending = [];
  const lineProblems = [];
  for (const name of judged) {
    const j = judge(name, liveBy.get(name) || null, beforeBy.get(name) || null, commentLines, before !== null);
    if (j.problems.length) pending.push({ name, problems: j.problems });
    lineProblems.push(...j.lineProblems);
  }
  const audit = uncheckable.length
    ? `${uncheckable.length} facet(s) cannot be checked against files (${uncheckable.map((u) => `${u.name}: ${u.reason}`).join(', ')}): run the trailhead audit verb to backfill them`
    : null;
  return {
    status: 'ok', ticket: o.ticket, issue: o.issue, floor: ctx.floor, commits: ctx.commits, touched: ctx.touched,
    flagged: flagged.map(({ name, stamp, covered, cites, textHash: h }) => ({ name, stamp, covered, cites, textHash: h })),
    uncheckable, pending, lineProblems, audit, bodyHash: sha256(read.body),
  };
}

// --- restamp -----------------------------------------------------------------------------
function parseReason(reason) {
  const i = String(reason || '').indexOf(': ');
  const file = i < 0 ? '' : reason.slice(0, i).trim();
  const why = i < 0 ? '' : reason.slice(i + 2).trim();
  if (!file || !why) throw new Fail('--reason must be "<file>: <why>" with a non-empty why', 'refused');
  return { file, why };
}

// Validated on the live body inside the write's compute step; a refusal there is
// recorded in `state` (nothing is written) and reported as a refusal, exit 2.
function restampCompute(o, ctx, reason, state) {
  return (body) => {
    state.refusal = null;
    const refuse = (msg) => { state.refusal = msg; return { error: msg }; };
    const matches = facetsOf(body).filter((f) => f.name === o.facet);
    if (matches.length === 0) return refuse(`no facet named "${o.facet}"`);
    if (matches.length > 1) return refuse(`duplicate facet name "${o.facet}"`);
    const [f] = matches;
    if (!touchedCites(citedPaths(f), ctx.touched).includes(reason.file)) {
      return refuse(`${reason.file} is not a touched file that facet "${o.facet}" cites`);
    }
    const text = f.text.replace(/^(?:[ \t]*\n)+/, '');
    const r = applyOp(body, { kind: 'replace', section: f.name, text, stamp: o.stamp });
    return r.error ? refuse(r.error) : r.body;
  };
}

function restamp(o, io) {
  const reason = parseReason(o.reason);
  if (!SHA_RE.test(String(o.stamp)) || !resolveCommit(o.repo, o.stamp)) throw new Fail(`--stamp ${o.stamp} is not a known commit sha`, 'refused');
  const commits = commitsOf(o.repo, o.ticket);
  if (!commits.length) throw new Fail(`no commit carries "Refs: #${o.ticket}": nothing to restamp against`);
  const ctx = { touched: touchedOf(o.repo, commits) };
  const state = { refusal: null };
  const g = guardedWrite(o.issue, restampCompute(o, ctx, reason, state), {
    gh: io.gh, repo: o.ghRepo, guard: io.guard, scanText: ' ', tmpdir: io.tmpdir, firstEditDelta2: io.firstEditDelta2,
  });
  if (state.refusal) throw new Fail(state.refusal, 'refused');
  if (!g.ok) return { code: 1, result: { status: 'error', error: g.reason } };
  return { code: 0, result: { status: 'restamped', line: `Codebase: ${o.facet} restamped, no change (${reason.file}: ${reason.why})` } };
}

// --- CLI -----------------------------------------------------------------------------------
const FLAGS = {
  check: { '--repo': 'repo', '--ticket': 'ticket', '--issue': 'issue', '--gh-repo': 'ghRepo', '--floor': 'floor', '--before': 'before', '--comment-file': 'commentFile' },
  restamp: { '--repo': 'repo', '--ticket': 'ticket', '--issue': 'issue', '--gh-repo': 'ghRepo', '--facet': 'facet', '--stamp': 'stamp', '--reason': 'reason' },
};
const REQUIRED = { check: ['ticket', 'issue', 'floor'], restamp: ['ticket', 'issue', 'facet', 'stamp'] };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!FLAGS[command]) throw new Fail('usage: trailhead-facet-touch.js <check|restamp> --repo <dir> --ticket <n> --issue <n> ...');
  const o = { command, repo: '.' };
  for (let i = 0; i < rest.length; i++) {
    const key = FLAGS[command][rest[i]];
    if (!key) throw new Fail(`usage: unknown argument: ${rest[i]}`);
    if (i + 1 >= rest.length) throw new Fail(`usage: ${rest[i]} requires a value`);
    o[key] = rest[++i];
  }
  for (const k of REQUIRED[command]) if (o[k] === undefined) throw new Fail(`usage: ${command} needs --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
  for (const k of ['ticket', 'issue']) {
    if (!/^\d+$/.test(o[k])) throw new Fail(`usage: --${k} must be a number, got: ${o[k]}`);
    o[k] = Number(o[k]);
  }
  return o;
}

function main(argv, { gh, stdout, guard, tmpdir, firstEditDelta2, cwd } = {}) {
  const out = stdout || process.stdout;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  try {
    const o = parseArgs(argv || []);
    o.repo = path.resolve(cwd || process.cwd(), o.repo);
    const io = { gh: gh || defaultGh, guard, tmpdir, firstEditDelta2 };
    if (o.command === 'check') { emit(check(o, io)); return 0; }
    const r = restamp(o, io);
    emit(r.result);
    return r.code;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    emit(err instanceof Fail && err.status !== 'error' ? { status: err.status, error: msg } : { status: 'error', error: msg });
    return 2;
  }
}

module.exports = { main, parseArgs, textHash, touchedCites, citedPaths };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout });
}
