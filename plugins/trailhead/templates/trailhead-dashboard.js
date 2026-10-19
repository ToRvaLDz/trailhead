#!/usr/bin/env node
'use strict';
// trailhead dashboard regeneration (self-contained, ships in templates/ so it
// reaches every install channel). Gathers the tracker data the pinned
// `trailhead:dashboard` issue indexes, renders the whole body deterministically
// and writes it through trailhead-issue-body.js's guarded write (fail-safe read,
// updatedAt check, post-write conflict check, secret scan). #253.
//
// CLI:
//   node trailhead-dashboard.js [--repo <owner/name>] [--set-last-audit <ISO-8601 UTC>] [--dry-run]
// --set-last-audit replaces the `<!-- trailhead:last-audit ... -->` marker (the
// audit's only writer path); without it the marker is copied verbatim from the
// existing body. --dry-run gathers and reads through gh, computes and scans, but
// writes, creates, pins and labels nothing; it prints the old and new byte sizes.
//
// Singleton labels (dashboard, codebase, conventions): more than one open issue
// aborts before any write, naming every duplicate by title and number.
//
// Self-heal: ensures the `trailhead:dashboard` label; creates the issue directly
// with the final scanned body when it is missing (never an empty or placeholder
// body) and pins it; re-pins it when unpinned. Never closes or prunes a map: the
// flags are signals, the offers stay with the agent.
//
// Prints exactly one line on stdout:
//   dashboard #33: 4 maps, whiteboard 1, flags: map-14 exhausted, map-98 near cap 92/100 (body 21034 -> 2210 bytes)
//   aborted: <reason>
// Exit 0 on success, 1 on an abort or a conflict, 2 on a usage error (stderr).
// A pin check or pin failure AFTER the body was written is not an abort: the line
// says `written, pin check failed: <reason>` (or `written, pin failed ...`) and the
// exit is 0, since the body is in place; the agent surfaces the pin problem.

const fs = require('fs');
const os = require('os');
const path = require('path');
const issueBody = require('./trailhead-issue-body.js');

const { guardedWrite, loadGuard, secretProblem, readSection, PLACEHOLDER_RE } = issueBody;

const LABEL = 'trailhead:dashboard';
const TITLE = '📊 trailhead dashboard';
const NEAR_CAP = 90;
const CAP = 100;
const RESOLVED_SHOWN = 10;
const AUDIT_LINE_RE = /^<!-- trailhead:last-audit [^ ]* -->[ \t\r]*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
// List-query limits; a list that comes back full is reported as truncated.
const LIMITS = { maps: 200, scoped: 1000, whiteboard: 200, resolved: 100, inbox: 1000 };
const NOT_RESOLVED_LABELS = ['trailhead:superseded', 'trailhead:out-of-scope'];

// --- pure render -------------------------------------------------------------

// A title safe to put inside a markdown link text, on one line. Comment
// delimiters are neutralised so a title can never forge the last-audit marker.
function linkText(title) {
  return String(title).replace(/\s+/g, ' ').trim()
    .replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;')
    .replace(/([\[\]])/g, '\\$1');
}

// The last-audit marker the dashboard itself wrote: a line of its own (the last
// such line), never text embedded in another line.
function extractAudit(body) {
  const hits = String(body).split('\n').filter((l) => AUDIT_LINE_RE.test(l));
  return hits.length ? hits[hits.length - 1].trim() : null;
}

const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`;
const link = (repo, n, text) => `[${text}](${issueUrl(repo, n)})`;

// The flags of one map, from its raw numbers. exhausted needs a zero open-scoped
// count AND a confirmed-empty fog; prunable needs the bounded closed-edge check.
function mapFlags(m) {
  const flags = [];
  if (m.openScoped === 0 && m.fog === false) flags.push('exhausted · closeable');
  if (m.total >= NEAR_CAP) {
    const base = `${m.total >= CAP ? 'at cap' : 'near cap'} · ${m.total}/${CAP}`;
    flags.push(m.closedEdges === true ? `${base} · prunable` : base);
  }
  return flags;
}

// Classifies the open whiteboard tickets with the panel's precedence: unverified
// (quarantined first), paused, blocked, in progress (assigned), frontier
// (everything else). A ticket lands in exactly one bucket. #263.
function classify(whiteboard) {
  const out = { frontier: [], inProgress: [], paused: [], blocked: [], unverified: [] };
  for (const t of whiteboard) {
    if (t.labels.includes('trailhead:unverified')) out.unverified.push(t);
    else if (t.labels.includes('trailhead:paused')) out.paused.push(t);
    else if (t.labels.includes('trailhead:blocked')) out.blocked.push(t);
    else if (t.assignees && t.assignees.length) out.inProgress.push(t);
    else out.frontier.push(t);
  }
  return out;
}

// snapshot: { repo, maps[], whiteboard[], resolved[], inbox, anchors, lastAudit }.
function renderDashboard(s) {
  const lines = [];
  lines.push("The pinned index of this repo's trailhead surface. Regenerate any time with `/trailhead:dashboard`; it also self-heals on `/trailhead`, `/trailhead:map`, and `/trailhead:whiteboard`.");
  lines.push('', '## 🗺 Maps');
  if (s.maps.length === 0) lines.push('_No open maps._');
  for (const m of s.maps) {
    lines.push(`- ${link(s.repo, m.number, linkText(m.title))}: ${m.openScoped} open${mapFlags(m).map((f) => ` · ${f}`).join('')}`);
  }
  const wb = classify(s.whiteboard);
  lines.push('', '## 🧷 Whiteboard (map-less tickets)');
  if (s.whiteboard.length === 0) lines.push('_Nothing on the whiteboard._');
  for (const [label, list] of [['Frontier', wb.frontier], ['In progress', wb.inProgress], ['Paused', wb.paused], ['Blocked', wb.blocked], ['Unverified', wb.unverified]]) {
    if (list.length === 0) continue;
    lines.push(`${label} (${list.length}):`);
    for (const t of list) lines.push(`- ${link(s.repo, t.number, `${linkText(t.title)} #${t.number}`)}`);
  }
  if (s.resolved.length) {
    lines.push('', `_Recently resolved: ${s.resolved.map((t) => link(s.repo, t.number, `${linkText(t.title)} #${t.number}`)).join(', ')}_`);
  }
  lines.push('', '## 📊 Counts');
  lines.push(`- Untriaged inbox: ${s.inbox}${(s.truncated || []).includes('inbox') ? '+' : ''}`);
  lines.push(`- Whiteboard frontier: ${wb.frontier.length}`);
  lines.push(`- Open maps: ${s.maps.length}`);
  const anchors = [['Codebase', s.anchors.codebase], ['Conventions', s.anchors.conventions]]
    .filter(([, n]) => n).map(([name, n]) => link(s.repo, n, `${name} #${n}`));
  if (anchors.length) lines.push('', `Anchors: ${anchors.join(' · ')}`);
  if (s.lastAudit) lines.push('', s.lastAudit);
  return lines.join('\n') + '\n';
}

// --- gather ------------------------------------------------------------------

class GatherError extends Error {}

function ghJson(gh, args) {
  const r = gh(args);
  if (r.status !== 0) throw new GatherError(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').split('\n').find((l) => l.trim()) || 'exit ' + r.status}`);
  try { return JSON.parse(r.stdout); } catch { throw new GatherError(`gh ${args.slice(0, 3).join(' ')} returned unparseable JSON`); }
}

function ghText(gh, args) {
  const r = gh(args);
  if (r.status !== 0) throw new GatherError(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || '').split('\n').find((l) => l.trim()) || 'exit ' + r.status}`);
  return r.stdout.trim();
}

const names = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name));

function issueList(gh, repo, extra) {
  return ghJson(gh, ['issue', 'list', ...extra, '-R', repo]);
}

function gatherMap(gh, repo, m, truncated) {
  const scoped = issueList(gh, repo, ['--label', `trailhead:map-${m.number}`, '--state', 'open', '--json', 'number', '--limit', String(LIMITS.scoped)]);
  if (scoped.length >= LIMITS.scoped) truncated.push(`map-${m.number} scoped`);
  const total = parseInt(ghText(gh, ['api', `repos/${repo}/issues/${m.number}`, '--jq', '.sub_issues_summary.total']), 10);
  if (!Number.isInteger(total)) throw new GatherError(`map #${m.number}: unreadable sub-issue total`);
  const out = { number: m.number, title: m.title, openScoped: scoped.length, total, fog: null, closedEdges: null };
  if (out.openScoped === 0) {
    // Candidate only: confirm the fog (`## Not yet specified`) is empty.
    const view = ghJson(gh, ['issue', 'view', String(m.number), '--json', 'body', '-R', repo]);
    const fog = readSection(String(view.body || ''), 'Not yet specified');
    // A missing section is unconfirmed (fog stays null: no exhausted flag), only
    // a present and empty one confirms there is no fog left.
    out.fog = fog === null ? null : fog.some((l) => !PLACEHOLDER_RE.test(l));
  }
  if (total >= NEAR_CAP) {
    const edges = ghJson(gh, ['api', `repos/${repo}/issues/${m.number}/sub_issues?per_page=100`]);
    out.closedEdges = Array.isArray(edges) && edges.some((e) => e && e.state === 'closed');
  }
  return out;
}

// Singleton labels: exactly one open issue each. More than one is ambiguous and
// never resolved by picking one (#274).
const SINGLETON_LIMIT = 10;
const SINGLETON_LABELS = [LABEL, 'trailhead:codebase', 'trailhead:conventions'];

// Looks up every singleton label first and aborts (GatherError) naming all the
// duplicated ones at once, before anything is written. Returns the single
// number per label, or null when there is none.
function lookupSingletons(gh, repo) {
  const found = SINGLETON_LABELS.map((label) => ({
    label,
    list: issueList(gh, repo, ['--label', label, '--state', 'open', '--json', 'number,title', '--limit', String(SINGLETON_LIMIT)]),
  }));
  const dupes = found.filter((f) => f.list.length > 1);
  if (dupes.length) {
    // Control characters are stripped so the one-line stdout stays safe; a list
    // that filled the fetch limit may be cut, so say more may exist.
    const safe = (title) => linkText(title).replace(/[\x00-\x1f\x7f]/g, '');
    const named = dupes.map((f) => `${f.label}: ${f.list.map((i) => `${safe(i.title)} (#${i.number})`).join(', ')}${f.list.length >= SINGLETON_LIMIT ? ', and possibly more' : ''}`).join('; ');
    throw new GatherError(`ambiguous singleton issues, close the duplicates and keep one: ${named}`);
  }
  const num = (label) => { const f = found.find((x) => x.label === label); return f.list.length ? f.list[0].number : null; };
  return { dashboard: num(LABEL), codebase: num('trailhead:codebase'), conventions: num('trailhead:conventions') };
}

function gatherSnapshot(gh, repo, singles) {
  const one = singles || lookupSingletons(gh, repo);
  const truncated = [];
  const capped = (list, limit, name) => { if (list.length >= limit) truncated.push(name); return list; };
  const maps = capped(issueList(gh, repo, ['--label', 'trailhead:map', '--state', 'open', '--json', 'number,title', '--limit', String(LIMITS.maps)]), LIMITS.maps, 'maps')
    .sort((a, b) => a.number - b.number)
    .map((m) => gatherMap(gh, repo, m, truncated));
  const whiteboard = capped(issueList(gh, repo, ['--label', 'trailhead:whiteboard', '--state', 'open', '--json', 'number,title,labels,assignees', '--limit', String(LIMITS.whiteboard)]), LIMITS.whiteboard, 'whiteboard')
    .map((t) => ({ number: t.number, title: t.title, labels: names(t.labels), assignees: (t.assignees || []).map((a) => a.login) }));
  // Most recently updated first, so the newest closures sit inside the fetched
  // window even on a repo with a long closed history; then ordered by closedAt.
  const closed = issueList(gh, repo, ['--label', 'trailhead:whiteboard', '--state', 'closed', '--search', 'sort:updated-desc', '--json', 'number,title,closedAt,labels', '--limit', String(LIMITS.resolved)]);
  const resolved = closed
    .filter((t) => !names(t.labels).some((n) => NOT_RESOLVED_LABELS.includes(n)))
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
    .slice(0, RESOLVED_SHOWN)
    .map((t) => ({ number: t.number, title: t.title }));
  // A full window only matters when it could not fill the shown list.
  if (closed.length >= LIMITS.resolved && resolved.length < RESOLVED_SHOWN) truncated.push('resolved');
  const openIssues = capped(issueList(gh, repo, ['--state', 'open', '--json', 'number,labels', '--limit', String(LIMITS.inbox)]), LIMITS.inbox, 'inbox');
  const inbox = openIssues.filter((i) => !names(i.labels).some((n) => n.startsWith('trailhead:'))).length;
  const anchors = { codebase: one.codebase, conventions: one.conventions };
  return { repo, maps, whiteboard, resolved, inbox, anchors, lastAudit: null, truncated };
}

// --- summary and self-heal ---------------------------------------------------

function flagSummary(maps) {
  const parts = [];
  for (const m of maps) {
    for (const f of mapFlags(m)) parts.push(`map-${m.number} ${f.replace(' · closeable', '').replace(/ · /g, ' ')}`);
  }
  return parts.length ? parts.join(', ') : 'none';
}

function summaryLine(number, snap) {
  const cut = snap.truncated && snap.truncated.length ? `, truncated: ${snap.truncated.join(', ')}` : '';
  return `dashboard${number === null ? '' : ' #' + number}: ${snap.maps.length} maps, whiteboard ${snap.whiteboard.length}, flags: ${flagSummary(snap.maps)}${cut}`;
}

function isPinned(gh, repo, number) {
  const [owner, name] = repo.split('/');
  const q = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){pinnedIssues(first:3){nodes{issue{number}}}}}';
  const data = ghJson(gh, ['api', 'graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `n=${name}`]);
  const nodes = (((data.data || {}).repository || {}).pinnedIssues || {}).nodes || [];
  return nodes.some((n) => n && n.issue && n.issue.number === number);
}

// Pins the issue; returns null on success or a short failure note.
function pin(gh, repo, number) {
  const node = gh(['api', `repos/${repo}/issues/${number}`, '--jq', '.node_id']);
  if (node.status !== 0 || !node.stdout.trim()) return 'pin failed (node id)';
  const r = gh(['api', 'graphql', '-f', 'query=mutation($id:ID!){ pinIssue(input:{issueId:$id}){ issue{ number } } }', '-F', `id=${node.stdout.trim()}`]);
  return r.status === 0 ? null : 'pin failed (pinned slots full?)';
}

function createDashboard(gh, repo, body, tmpdir) {
  const dir = fs.mkdtempSync(path.join(tmpdir || os.tmpdir(), 'trailhead-dashboard-'));
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, body);
    const r = gh(['issue', 'create', '--title', TITLE, '--label', LABEL, '--body-file', file, '-R', repo]);
    if (r.status !== 0) return { error: `gh issue create failed: ${(r.stderr || '').split('\n').find((l) => l.trim()) || 'exit ' + r.status}` };
    const m = /\/issues\/(\d+)\s*$/.exec(r.stdout.trim());
    return m ? { number: Number(m[1]) } : { error: 'gh issue create returned no issue url' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const o = { repo: null, setLastAudit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') { o.dryRun = true; continue; }
    if (flag !== '--repo' && flag !== '--set-last-audit') return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else {
      if (!ISO_RE.test(v)) return { error: `usage: --set-last-audit must be an ISO-8601 UTC time like 2026-10-14T09:30:00Z, got: ${v}` };
      o.setLastAudit = v;
    }
  }
  return o;
}

function defaultRepo(gh) {
  const r = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const slug = r.status === 0 ? r.stdout.trim() : '';
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

function main(argv, { gh, stdout, stderr, guard, tmpdir, firstEditDelta2 } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || issueBody.defaultGh;
  const g = guard === undefined ? loadGuard() : guard;
  const abort = (reason) => { out.write(`aborted: ${reason}\n`); return 1; };

  try {
    const repo = o.repo || defaultRepo(run);
    if (!repo) return abort('cannot resolve the repository (pass --repo owner/name)');
    const singles = lookupSingletons(run, repo); // fail closed on duplicates, before any write
    if (!o.dryRun) run(['label', 'create', LABEL, '--color', '5319E7', '--description', 'Pinned index of the trailhead surface', '-R', repo]); // idempotent, failure = already there
    const snap = gatherSnapshot(run, repo, singles);
    const marker = o.setLastAudit ? `<!-- trailhead:last-audit ${o.setLastAudit} -->` : null;
    const number = singles.dashboard;

    if (number === null) {
      const body = renderDashboard({ ...snap, lastAudit: marker });
      const problem = secretProblem(body, g);
      if (problem) return abort(problem);
      if (o.dryRun) {
        out.write(`${summaryLine(null, snap)} (dry-run: would create and pin, body ${Buffer.byteLength(body)} bytes), nothing written\n`);
        return 0;
      }
      const created = createDashboard(run, repo, body, tmpdir);
      if (created.error) return abort(created.error);
      const note = pin(run, repo, created.number);
      out.write(`${summaryLine(created.number, snap)} (created${note ? ', ' + note : ' and pinned'}, body ${Buffer.byteLength(body)} bytes)\n`);
      return 0;
    }

    const w = guardedWrite(number, (current) => {
      const carried = marker || extractAudit(current);
      return renderDashboard({ ...snap, lastAudit: carried });
    }, { gh: run, repo, guard: g, dryRun: o.dryRun, tmpdir, firstEditDelta2 });
    if (!w.ok) return abort(w.reason);
    const sizes = `body ${w.oldSize} -> ${w.newSize} bytes`;
    if (w.dryRun) {
      out.write(`${summaryLine(number, snap)} (dry-run, ${sizes}), nothing written\n`);
      return 0;
    }
    // The body is already written: a pin check or pin failure is reported next to
    // that fact (exit 0), never as an abort that looks like nothing was written.
    let note = w.historyFull ? issueBody.HISTORY_FULL_NOTE.replace(/^ \((.*)\)$/, ', $1') : '';
    try {
      if (!isPinned(run, repo, number)) {
        const failed = pin(run, repo, number);
        note += failed ? `, written, ${failed}` : ', re-pinned';
      }
    } catch (e) {
      note += `, written, pin check failed: ${e && e.message ? e.message : String(e)}`;
    }
    out.write(`${summaryLine(number, snap)} (${sizes}${note})\n`);
    return 0;
  } catch (e) {
    if (e instanceof GatherError) return abort(e.message);
    return abort(`unexpected error: ${e && e.message ? e.message : String(e)}`);
  }
}

module.exports = { renderDashboard, mapFlags, classify, gatherSnapshot, parseArgs, main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
