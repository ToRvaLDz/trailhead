#!/usr/bin/env node
'use strict';
// trailhead merge-ticket helper (self-contained, ships in templates/ so it reaches
// every install channel). When an autonomous run leaves a slot branch unmerged (a
// `conflict` from trailhead-auto-merge.js merge), this opens, or updates, the one merge
// ticket of that ticket's map (or of the whiteboard), right then. #287.
//
// CLI:
//   node trailhead-merge-ticket.js add --scope <map-<n>|whiteboard> --ticket <n>
//        --file <path> [--file <path> ...] --workspace <path> --repo <owner/name>
// The branch is derived as `trailhead/t<ticket>`. --file is repeatable and taken as
// is (one per conflicting path, commas allowed).
//
// Find: every OPEN issue labelled with the scope (`trailhead:map-<n>` or
// `trailhead:whiteboard`) is read with a paginated GraphQL query (`gh api graphql`,
// 100 per page, not `gh issue list`, whose search index lags), and those whose body
// has the marker line are the scope's merge tickets; the lowest-numbered one is
// reused. A read that fails, is unparseable, carries GraphQL errors, has an unexpected
// shape, or exceeds the page cap (100 pages) is an error, never "none found".
//
// The data lives in one marker line, `<!-- trailhead:merge-ticket v1 <base64 of the
// JSON entry list> -->`; the readable list is rendered from the entries only, never
// parsed back from prose. An unknown version or an undecodable payload on the found
// issue is an error with nothing written.
//
// Create (none open): ensures the `trailhead:needs-you` label, secret-scans the body
// (fail closed), opens the ticket (`trailhead:ticket`, `trailhead:task`,
// `trailhead:needs-you`, the scope label), and for a map wires the native sub-issue
// edge (a failure is a warning). Update (one open): the guarded body write of
// trailhead-issue-body.js (guardedWrite) re-reads the issue, upserts this ticket's
// entry and re-renders the whole body; a repeat add with the same files and workspace
// is `unchanged` and writes nothing.
//
// Prints exactly one JSON line on stdout:
//   ok:    {"status":"ok","action":"created|updated|unchanged","issue":n,"url":"...","scope":"...","entries":k,"warnings":[...]}
//   error: {"status":"error","reason":"..."}
// Exit 0 on ok, 1 on an error, 2 on a usage error (stderr).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { guardedWrite, loadGuard, secretProblem } = require('./trailhead-issue-body.js');

const MAX_PAGES = 100; // 100 pages x 100 issues
const VERSION = 'v1';
const MARKER_PREFIX = '<!-- trailhead:merge-ticket ';
const MARKER_RE = /^<!-- trailhead:merge-ticket (\S+) (\S*) -->$/;
const NEEDS_YOU = 'trailhead:needs-you';
const NEEDS_YOU_COLOR = 'D93F0B';
const NEEDS_YOU_DESC = 'Needs you: an autonomous run parked it for the human';
const TITLE_PREFIX = 'Merge the branches left unmerged: ';

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const byNumber = (a, b) => a.number - b.number;

// --- args ---------------------------------------------------------------------

function parseArgs(argv) {
  const cmd = argv[0];
  if (cmd !== 'add') return { error: `usage: expected add, got: ${cmd === undefined ? '(nothing)' : cmd}` };
  const o = { cmd, scope: null, ticket: null, files: [], workspace: null, repo: null };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--scope', '--ticket', '--file', '--workspace', '--repo'].includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else if (flag === '--ticket') {
      if (!/^[1-9]\d*$/.test(v)) return { error: `usage: --ticket must be a positive integer, got: ${v}` };
      o.ticket = Number(v);
    } else if (flag === '--scope') {
      if (v !== 'whiteboard' && !/^map-[1-9]\d*$/.test(v)) return { error: `usage: --scope must be map-<n> or whiteboard, got: ${v}` };
      o.scope = v;
    } else if (flag === '--file') {
      if (v === '') return { error: 'usage: --file must not be empty' };
      o.files.push(v);
    } else {
      if (v.trim() === '') return { error: 'usage: --workspace must not be empty' };
      o.workspace = v;
    }
  }
  if (!o.repo) return { error: 'usage: add requires --repo' };
  if (!o.scope) return { error: 'usage: add requires --scope' };
  if (!o.ticket) return { error: 'usage: add requires --ticket' };
  if (!o.files.length) return { error: 'usage: add requires at least one --file' };
  if (!o.workspace) return { error: 'usage: add requires --workspace' };
  return o;
}

const scopeLabel = (scope) => (scope === 'whiteboard' ? 'trailhead:whiteboard' : `trailhead:${scope}`);
const branchOf = (ticket) => `trailhead/t${ticket}`;

// --- marker -------------------------------------------------------------------

const isEntry = (e) => e && typeof e === 'object'
  && Number.isInteger(e.ticket) && e.ticket > 0
  && ['title', 'url', 'branch', 'workspace'].every((k) => typeof e[k] === 'string')
  && Array.isArray(e.files) && e.files.length > 0 && e.files.every((f) => typeof f === 'string' && f !== '');

function encodeMarker(entries) {
  return `${MARKER_PREFIX}${VERSION} ${Buffer.from(JSON.stringify(entries), 'utf8').toString('base64')} -->`;
}

// { entries } or { error }. The body must carry exactly one marker line.
function decodeMarker(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n').filter((l) => l.startsWith(MARKER_PREFIX));
  if (lines.length === 0) return { error: 'the merge ticket has no marker line' };
  if (lines.length > 1) return { error: 'the merge ticket has more than one marker line' };
  const m = MARKER_RE.exec(lines[0].trimEnd());
  if (!m) return { error: 'the merge ticket marker line is malformed' };
  if (m[1] !== VERSION) return { error: `the merge ticket marker has an unknown version: ${m[1]}` };
  let list;
  try { list = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')); } catch { return { error: 'the merge ticket marker payload cannot be decoded' }; }
  if (!Array.isArray(list) || !list.every(isEntry)) return { error: 'the merge ticket marker payload is not a valid entry list' };
  return { entries: list };
}

const hasMarker = (body) => String(body || '').replace(/\r/g, '').split('\n').some((l) => l.startsWith(MARKER_PREFIX));

// --- rendering ----------------------------------------------------------------

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');

// Link text: no newline, no backtick, no brackets, no raw `<` (a `<!--` would hide the body).
const linkText = (s) => oneLine(s).replace(/`/g, "'").replace(/</g, '&lt;').replace(/\[/g, '(').replace(/\]/g, ')');

// Inline code that survives backticks in the text: a fence longer than any run inside.
function code(s) {
  const t = oneLine(s);
  const longest = Math.max(0, ...(t.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

const byTicket = (a, b) => a.ticket - b.ticket;

function renderEntry(e, all, index) {
  const others = all.filter((o) => o.ticket !== e.ticket)
    .map((o) => ({ o, shared: o.files.filter((f) => e.files.includes(f)) }))
    .filter((x) => x.shared.length);
  const lines = [
    `${index}. ${code(e.branch)}: [#${e.ticket} ${linkText(e.title)}](${e.url})`,
    `   - Workspace: ${code(e.workspace)}`,
    `   - Conflicting files: ${e.files.map(code).join(', ')}`,
  ];
  if (others.length) lines.push(`   - Also touched by: ${others.map((x) => `${code(x.o.branch)} (${x.shared.map(code).join(', ')})`).join('; ')}`);
  return lines.join('\n');
}

// The whole body from the entries alone. parentLine is kept verbatim ('' for none).
function renderBody(entriesIn, parentLine) {
  const entries = [...entriesIn].sort(byTicket);
  const parts = [];
  if (parentLine) parts.push(parentLine, '');
  parts.push(
    '## Question',
    'Merge into the trunk the branches an autonomous run left unmerged.',
    '',
    '## Unmerged branches',
    'Suggested merge order: oldest ticket first (a suggestion, not the order the run followed). After each branch lands, re-check each later one against the trunk before merging it.',
    '',
    ...entries.map((e, i) => renderEntry(e, entries, i + 1)),
    '',
    '## Done when',
    '- Each listed branch is merged into the trunk or dropped, and its ticket resolved.',
    '- Close this ticket when the list is done.',
    '',
    encodeMarker(entries),
    '',
  );
  return parts.join('\n');
}

// Pure: replace the entry of the same ticket in place or append it.
function upsert(entries, entry) {
  const at = entries.findIndex((e) => e.ticket === entry.ticket);
  return at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e));
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// --- tracker reads ------------------------------------------------------------

const query = (label) => `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,labels:["${label}"],states:[OPEN],orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title body url} pageInfo{hasNextPage endCursor}}}}`;

// { merge: [{number,title,body,url}] sorted ascending } or { error }.
function findOpen(run, repo, label) {
  const [owner, name] = repo.split('/');
  const rows = [];
  let after = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) return { error: `incomplete read: more than ${MAX_PAGES} pages of ${label} issues` };
    const args = ['api', 'graphql', '-f', `query=${query(label)}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
    if (after !== null) args.push('-f', `after=${after}`);
    const r = run(args);
    if (r.status !== 0) return { error: `gh api graphql failed: ${firstLine(r.stderr) || 'exit ' + r.status}` };
    let body;
    try { body = JSON.parse(r.stdout); } catch { return { error: 'gh api graphql returned unparseable JSON' }; }
    if (!body || typeof body !== 'object') return { error: 'gh api graphql returned unexpected JSON' };
    if (Array.isArray(body.errors) && body.errors.length) return { error: `graphql errors: ${firstLine(body.errors[0] && body.errors[0].message) || 'unknown'}` };
    const repoNode = body.data && body.data.repository;
    if (!repoNode) return { error: 'repository not found in the graphql response' };
    const issues = repoNode.issues;
    if (!issues || !Array.isArray(issues.nodes)) return { error: 'graphql response has no issues.nodes' };
    const info = issues.pageInfo;
    if (!info || typeof info.hasNextPage !== 'boolean') return { error: 'graphql response has no pageInfo' };
    rows.push(...issues.nodes.filter((n) => n && typeof n === 'object'));
    if (!info.hasNextPage) break;
    if (typeof info.endCursor !== 'string' || !info.endCursor) return { error: 'graphql pageInfo has hasNextPage without an endCursor' };
    after = info.endCursor;
  }
  return { merge: rows.filter((i) => Number.isInteger(i.number) && hasMarker(i.body)).sort(byNumber) };
}

// { title, url } of an issue, or { error }.
function viewIssue(run, repo, n) {
  const r = run(['issue', 'view', String(n), '--json', 'title,url', '-R', repo]);
  if (r.status !== 0) return { error: `gh issue view #${n} failed: ${firstLine(r.stderr) || 'exit ' + r.status}` };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: `gh issue view #${n} returned unparseable JSON` }; }
  if (!j || typeof j.title !== 'string' || typeof j.url !== 'string' || !j.title || !j.url) return { error: `gh issue view #${n} returned no title or url` };
  return { title: j.title, url: j.url };
}

// --- create -------------------------------------------------------------------

function create(run, o, entry, ctx) {
  const labels = ['trailhead:ticket', 'trailhead:task', NEEDS_YOU, scopeLabel(o.scope)];
  let title;
  let parentLine = '';
  if (o.scope === 'whiteboard') {
    title = `${TITLE_PREFIX}whiteboard`;
  } else {
    const n = Number(o.scope.slice(4));
    const map = viewIssue(run, o.repo, n);
    if (map.error) return { error: map.error };
    title = `${TITLE_PREFIX}${oneLine(map.title)}`;
    parentLine = `Parent: [${linkText(map.title)}](${map.url})`;
  }
  const body = renderBody([entry], parentLine);
  const problem = secretProblem(`${title}\n${body}`, ctx.guard);
  if (problem) return { error: problem };

  const ensure = run(['label', 'create', NEEDS_YOU, '--color', NEEDS_YOU_COLOR, '--description', NEEDS_YOU_DESC, '--force', '-R', o.repo]);
  if (ensure.status !== 0) return { error: `gh label create failed: ${firstLine(ensure.stderr) || 'exit ' + ensure.status}` };

  let dir = null;
  let made;
  try {
    dir = fs.mkdtempSync(path.join(ctx.tmpdir || os.tmpdir(), 'trailhead-merge-ticket-'));
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, body);
    made = run(['issue', 'create', '--title', title, '--body-file', file, ...labels.flatMap((l) => ['--label', l]), '-R', o.repo]);
  } catch (e) {
    return { error: `could not stage the body in a temp file, nothing written: ${firstLine(e && e.message)}` };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ } }
  }
  if (made.status !== 0) return { error: `gh issue create failed: ${firstLine(made.stderr) || 'exit ' + made.status}` };
  const m = /\/issues\/(\d+)\s*$/.exec(made.stdout.trim());
  if (!m) return { error: 'gh issue create returned no issue url' };
  const number = Number(m[1]);
  const url = made.stdout.trim();
  const warnings = [];

  if (o.scope !== 'whiteboard') {
    const parent = Number(o.scope.slice(4));
    const w = wireSubIssue(run, o.repo, parent, number);
    if (w) warnings.push(w);
  }
  return { number, url, warnings };
}

// null on success, else the warning text.
function wireSubIssue(run, repo, parent, child) {
  const got = run(['api', `repos/${repo}/issues/${child}`]);
  let id = null;
  if (got.status === 0) { try { id = JSON.parse(got.stdout).id; } catch { /* handled below */ } }
  if (!Number.isInteger(id)) return `sub-issue edge not wired: could not read the id of #${child}${got.status === 0 ? '' : ': ' + (firstLine(got.stderr) || 'exit ' + got.status)}`;
  const r = run(['api', '--method', 'POST', `repos/${repo}/issues/${parent}/sub_issues`, '-F', `sub_issue_id=${id}`]);
  return r.status === 0 ? null : `sub-issue edge not wired: ${firstLine(r.stderr) || 'exit ' + r.status}`;
}

// --- main ---------------------------------------------------------------------

function main(argv, { gh, guard, tmpdir, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason) => { emit({ status: 'error', reason }); return 1; };
  const ctx = { guard: guard === undefined ? loadGuard() : guard, tmpdir };
  const label = scopeLabel(o.scope);
  const done = (action, issue, url, entries, warnings) => {
    emit({ status: 'ok', action, issue, url, scope: o.scope, entries, warnings });
    return 0;
  };
  const twinWarning = (list) => (list.length > 1
    ? [`more than one open merge ticket for ${o.scope}: ${list.map((i) => '#' + i.number).join(', ')} (none closed; the human merges them)`]
    : []);

  const found = findOpen(run, o.repo, label);
  if (found.error) return fail(found.error);
  const wanted = { branch: branchOf(o.ticket), workspace: o.workspace, files: o.files };

  if (found.merge.length === 0) {
    const t = viewIssue(run, o.repo, o.ticket);
    if (t.error) return fail(t.error);
    const entry = { ticket: o.ticket, title: t.title, url: t.url, ...wanted };
    const made = create(run, o, entry, ctx);
    if (made.error) return fail(made.error);
    const warnings = [...made.warnings];
    const again = findOpen(run, o.repo, label);
    if (again.error) warnings.push(`could not re-check for duplicate merge tickets: ${again.error}`);
    else warnings.push(...twinWarning(again.merge));
    return done('created', made.number, made.url, 1, warnings);
  }

  const target = found.merge[0];
  const cur = decodeMarker(target.body);
  if (cur.error) return fail(`#${target.number}: ${cur.error}, nothing written`);
  const prior = cur.entries.find((e) => e.ticket === o.ticket);
  if (prior && prior.workspace === o.workspace && sameList(prior.files, o.files)) {
    return done('unchanged', target.number, target.url, cur.entries.length, twinWarning(found.merge));
  }

  let info = prior ? { title: prior.title, url: prior.url } : viewIssue(run, o.repo, o.ticket);
  if (info.error) return fail(info.error);
  let count = 0;
  const compute = (fresh) => {
    const dec = decodeMarker(fresh);
    if (dec.error) return { error: `${dec.error}, nothing written` };
    const old = dec.entries.find((e) => e.ticket === o.ticket);
    if (old && !prior) info = { title: old.title, url: old.url };
    const entries = upsert(dec.entries, { ticket: o.ticket, title: info.title, url: info.url, ...wanted });
    count = entries.length;
    const parent = String(fresh).replace(/\r/g, '').split('\n').find((l) => l.startsWith('Parent: ')) || '';
    return renderBody(entries, parent);
  };
  const g = guardedWrite(target.number, compute, { gh: run, repo: o.repo, guard: ctx.guard, tmpdir });
  if (!g.ok) return fail(`#${target.number}: ${g.reason}`);
  return done('updated', target.number, target.url, count, twinWarning(found.merge));
}

module.exports = { main, parseArgs, encodeMarker, decodeMarker, renderBody, upsert, findOpen };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
