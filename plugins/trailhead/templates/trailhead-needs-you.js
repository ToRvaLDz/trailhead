#!/usr/bin/env node
'use strict';
// trailhead needs-you helper (self-contained, ships in templates/ so it reaches every
// install channel). Marks a ticket an autonomous run parked for the human, and clears
// the mark when a human takes the ticket back. #282.
//
// CLI:
//   node trailhead-needs-you.js park  --issue <n> --reason <text> --repo <owner/name>
//   node trailhead-needs-you.js clear --issue <n> --repo <owner/name>
//
// park, in this order (so any partial failure leaves the ticket visible: a label is
// never set on a ticket still claimed by the run):
//   1. secret-scan the reason with the shipped secret-guard (fail closed: nothing is
//      written when the guard is missing or hits);
//   2. ensure the repo label `trailhead:needs-you` (`gh label create --force`);
//   3. read the ticket's labels, assignees and comments;
//   4. post a comment whose first line is exactly `NEEDS YOU`, a blank line, then the
//      reason, unless the latest comment with that first line carries the same reason
//      (whitespace-normalised). Limit: dedup only sees the comments `gh` returns, so on
//      a very long thread the worst case is one duplicate comment, never a missing one;
//   5. unassign `@me` when the ticket is assigned;
//   6. add the label last.
// clear: when the ticket carries the label, remove it; otherwise a no-op.
//
// Prints exactly one JSON line on stdout:
//   park:  {"status":"ok","issue":n,"commented":bool,"unassigned":bool,"labelled":bool}
//   clear: {"status":"ok","issue":n,"cleared":bool}
//   error: {"status":"error","reason":"..."}
// Exit 0 on ok, 1 on an error (any failed or unparseable gh step), 2 on a usage error
// (stderr).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LABEL = 'trailhead:needs-you';
const LABEL_COLOR = 'D93F0B';
const LABEL_DESC = 'Needs you: an autonomous run parked it for the human';
const MARKER = 'NEEDS YOU';

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// --- secret guard (same approach as trailhead-issue-body.js) -----------------

function guardCandidates() {
  return [
    path.join(__dirname, '..', 'hooks', 'trailhead-secret-guard.js'),
    path.join(__dirname, '..', '..', 'hooks', 'trailhead-secret-guard.js'),
  ];
}

// The shipped secret-guard module ({ scan }), or null when none is found.
function loadGuard(candidates = guardCandidates()) {
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const m = require(file);
      if (m && typeof m.scan === 'function') return m;
    } catch { /* try the next layout */ }
  }
  return null;
}

// null when the text is clean, else the abort reason (fail closed).
function secretProblem(text, guard) {
  if (!guard || typeof guard.scan !== 'function') return 'secret-scan unavailable, nothing written';
  try {
    const hit = guard.scan(text, {});
    return hit ? `secret detected (${hit}) in the reason, nothing written` : null;
  } catch {
    return 'secret-scan unavailable, nothing written';
  }
}

// --- args ---------------------------------------------------------------------

function parseArgs(argv) {
  const cmd = argv[0];
  if (cmd !== 'park' && cmd !== 'clear') return { error: `usage: expected park or clear, got: ${cmd === undefined ? '(nothing)' : cmd}` };
  const allowed = cmd === 'park' ? ['--issue', '--reason', '--repo'] : ['--issue', '--repo'];
  const o = { cmd, issue: null, reason: null, repo: null };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else if (flag === '--issue') {
      if (!/^[1-9]\d*$/.test(v)) return { error: `usage: --issue must be a positive integer, got: ${v}` };
      o.issue = Number(v);
    } else {
      o.reason = v;
    }
  }
  if (!o.repo) return { error: `usage: ${cmd} requires --repo` };
  if (!o.issue) return { error: `usage: ${cmd} requires --issue` };
  if (cmd === 'park' && (o.reason === null || !o.reason.trim())) return { error: 'usage: park requires a non-empty --reason' };
  return o;
}

// --- gh steps -----------------------------------------------------------------

// { labels:[names], assignees:[logins], comments:[bodies] } or { error }.
function readIssue(run, o) {
  const r = run(['issue', 'view', String(o.issue), '--json', 'labels,assignees,comments', '-R', o.repo]);
  if (r.status !== 0) return { error: `gh issue view failed: ${firstLine(r.stderr) || 'exit ' + r.status}` };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: 'gh issue view returned unparseable JSON' }; }
  if (!j || typeof j !== 'object') return { error: 'gh issue view returned unexpected JSON' };
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    labels: list(j.labels).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean),
    assignees: list(j.assignees).map((a) => (typeof a === 'string' ? a : a && a.login)).filter(Boolean),
    comments: list(j.comments).map((c) => (typeof c === 'string' ? c : String((c && c.body) || ''))),
  };
}

// True when the latest NEEDS YOU comment already carries this reason.
function alreadyCommented(comments, reason) {
  const mine = comments.filter((b) => String(b).replace(/\r/g, '').split('\n')[0] === MARKER);
  if (!mine.length) return false;
  const latest = String(mine[mine.length - 1]).replace(/\r/g, '');
  return norm(latest.slice(latest.indexOf('\n') + 1)) === norm(reason);
}

function main(argv, { gh, guard, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason) => { emit({ status: 'error', reason }); return 1; };
  const R = ['-R', o.repo];
  const n = String(o.issue);

  if (o.cmd === 'clear') {
    const cur = readIssue(run, o);
    if (cur.error) return fail(cur.error);
    if (!cur.labels.includes(LABEL)) { emit({ status: 'ok', issue: o.issue, cleared: false }); return 0; }
    const r = run(['issue', 'edit', n, '--remove-label', LABEL, ...R]);
    if (r.status !== 0) return fail(`gh issue edit (remove label) failed: ${firstLine(r.stderr) || 'exit ' + r.status}`);
    emit({ status: 'ok', issue: o.issue, cleared: true });
    return 0;
  }

  const problem = secretProblem(o.reason, guard === undefined ? loadGuard() : guard);
  if (problem) return fail(problem);

  const ensure = run(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESC, '--force', ...R]);
  if (ensure.status !== 0) return fail(`gh label create failed: ${firstLine(ensure.stderr) || 'exit ' + ensure.status}`);

  const cur = readIssue(run, o);
  if (cur.error) return fail(cur.error);

  let commented = false;
  if (!alreadyCommented(cur.comments, o.reason)) {
    const c = run(['issue', 'comment', n, '--body', `${MARKER}\n\n${o.reason.trim()}`, ...R]);
    if (c.status !== 0) return fail(`gh issue comment failed: ${firstLine(c.stderr) || 'exit ' + c.status}`);
    commented = true;
  }

  let unassigned = false;
  if (cur.assignees.length) {
    const u = run(['issue', 'edit', n, '--remove-assignee', '@me', ...R]);
    if (u.status !== 0) return fail(`gh issue edit (unassign) failed: ${firstLine(u.stderr) || 'exit ' + u.status}`);
    unassigned = true;
  }

  let labelled = false;
  if (!cur.labels.includes(LABEL)) {
    const l = run(['issue', 'edit', n, '--add-label', LABEL, ...R]);
    if (l.status !== 0) return fail(`gh issue edit (add label) failed: ${firstLine(l.stderr) || 'exit ' + l.status}`);
    labelled = true;
  }
  emit({ status: 'ok', issue: o.issue, commented, unassigned, labelled });
  return 0;
}

module.exports = { main, parseArgs, alreadyCommented, loadGuard, secretProblem };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
