#!/usr/bin/env node
'use strict';
// trailhead issue-body editor (self-contained, ships in templates/ so it reaches
// every install channel). Owns the mechanics of the fail-safe body
// read-modify-write that Resolve bookkeeping repeats (a map's `Decisions so far`
// line, a facet or conventions header patch): the agent keeps the words, this
// keeps the guards. #253.
//
// CLI:
//   node trailhead-issue-body.js <append|replace|remove> --issue <n> [--repo <owner/name>]
//        --section "<name>" (--line "<text>" | --file <path> | --match "<text>") [--dry-run]
//   append   adds --line as the last line of the section (a `_none yet_`-style
//            placeholder that is the section's only content is dropped)
//   replace  swaps the section content for the text of --file
//   remove   drops the one list entry (a `- ` line plus its indented lines) that
//            contains --match: zero matches = reported no-op, more than one = abort
// <name> matches a `## ` heading with its leading emoji/punctuation stripped
// (`Decisions so far` matches `## ✅ Decisions so far`); `:preamble` is the text
// before the first `## ` (the conventions header).
// --dry-run reads and computes (secret scan included) but writes nothing and
// prints the old and new byte sizes.
//
// Guards (guardedWrite, reused by trailhead-dashboard.js): the body is read with
// one retry; a non-zero exit, unparseable JSON, an empty or degenerate body, a
// missing section or an empty result aborts with nothing written. updatedAt is
// re-read just before the write (moved: re-read and re-apply once, then abort).
// GitHub has no conditional issue write, so a post-write check closes the rest of
// the window: the issue's userContentEdits count is recorded before the write and
// compared after it, with an exact read-back of the body; anything but our own
// single write is a `conflict` (exit 1, never silent). The text to insert is
// scanned with the shipped secret-guard, found next to the hooks; no guard
// module = fail closed.
//
// Prints exactly one line, never the body, on stdout:
//   issue #N: appended 1 line to "Decisions so far"   |   aborted: <reason>
// Exit 0 on success and on a reported no-op; 1 on an abort; 2 on a usage error
// (message on stderr, nothing on stdout, nothing read or written).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PREAMBLE = ':preamble';
const DEGENERATE_MAX = 20; // a body with fewer non-space characters is degenerate
const EDIT_HISTORY_HINT = "open the issue's edit history (the `edited` menu) and re-apply the lost lines";
// Whether GitHub records the original version as an extra edit on an issue's
// first edit (delta 2). Confirmed live (2026-10-14): a never-edited issue goes
// from 0 to 2 edits on its first body write, then +1 per write.
const FIRST_EDIT_DELTA2 = true;
const PLACEHOLDER_RE = /^\s*(?:[-*+]\s+)?[_*]*\(?\s*(?:none(?:\s+yet)?|nothing(?:\s+yet)?|n\/a|tbd|empty)\s*\)?[_*]*\.?\s*$/i;

// --- pure section splice ------------------------------------------------------

// Splits a body into lines, remembering the line ending and the final newline.
function splitBody(body) {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const finalNl = /\n$/.test(body);
  const lines = body.split(/\r?\n/);
  if (finalNl) lines.pop();
  return { lines, eol, finalNl };
}

function joinBody({ lines, eol, finalNl }) {
  return lines.join(eol) + (finalNl ? eol : '');
}

// Heading text with leading emoji/punctuation stripped, or null for a non-heading.
function headingName(line) {
  const m = /^##[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  return m[1].replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// Indexes of the `## ` headings outside fenced code blocks.
function headingIndexes(lines) {
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (f) { fence = { char: f[1][0], len: f[1].length }; return; }
    if (headingName(line) !== null) out.push(i);
  });
  return out;
}

// Locates a section: { head, from, to } where lines[from..to) is its content
// (head is -1 for the preamble). null when the section does not exist.
function findSection(lines, name) {
  const heads = headingIndexes(lines);
  if (name === PREAMBLE) return { head: -1, from: 0, to: heads.length ? heads[0] : lines.length };
  const k = heads.findIndex((i) => headingName(lines[i]) === name);
  if (k < 0) return null;
  return { head: heads[k], from: heads[k] + 1, to: k + 1 < heads.length ? heads[k + 1] : lines.length };
}

const isBlank = (l) => l.trim() === '';

// End (exclusive) of the section's content without its trailing blank lines.
function contentEnd(lines, sec) {
  let end = sec.to;
  while (end > sec.from && isBlank(lines[end - 1])) end--;
  return end;
}

function bodyLines(text) {
  const t = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return t === '' ? [] : t.split('\n');
}

// A list entry: a top-level `- ` line plus the indented lines that follow it.
function listEntries(lines, sec) {
  const entries = [];
  const end = contentEnd(lines, sec);
  for (let i = sec.from; i < end; i++) {
    if (!/^[-*+][ \t]/.test(lines[i])) continue;
    let j = i + 1;
    while (j < end && /^[ \t]+\S/.test(lines[j])) j++;
    entries.push({ start: i, end: j, text: lines.slice(i, j).join('\n') });
    i = j - 1;
  }
  return entries;
}

// The non-blank content lines of a section, or null when the section is missing.
function readSection(body, name) {
  const { lines } = splitBody(String(body));
  const sec = findSection(lines, name);
  return sec ? lines.slice(sec.from, sec.to).filter((l) => !isBlank(l)) : null;
}

// op: { kind: 'append'|'replace'|'remove', section, line|text|match }.
// Returns { body, changed, summary } or { error }.
function applyOp(body, op) {
  const parts = splitBody(String(body));
  const { lines } = parts;
  const sec = findSection(lines, op.section);
  if (!sec) return { error: `section not found: ${op.section}` };
  const nextHeading = sec.to < lines.length;
  const label = op.section === PREAMBLE ? 'the preamble' : `"${op.section}"`;

  if (op.kind === 'append') {
    if (/[\r\n]/.test(op.line)) return { error: 'append takes a single line (no newline)' };
    const end = contentEnd(lines, sec);
    const content = lines.slice(sec.from, end).filter((l) => !isBlank(l));
    let next;
    if (content.length === 0) {
      const insert = sec.head >= 0 ? ['', op.line] : [op.line];
      next = [...lines.slice(0, sec.from), ...insert, ...lines.slice(sec.from)];
      if (sec.head < 0 && nextHeading) next.splice(sec.from + 1, 0, '');
    } else if (content.length === 1 && PLACEHOLDER_RE.test(content[0])) {
      const at = lines.findIndex((l, i) => i >= sec.from && i < end && !isBlank(l));
      next = [...lines.slice(0, at), op.line, ...lines.slice(at + 1)];
    } else {
      next = [...lines.slice(0, end), op.line, ...lines.slice(end)];
    }
    return { body: joinBody({ ...parts, lines: next }), changed: true, summary: `appended 1 line to ${label}` };
  }

  if (op.kind === 'replace') {
    const end = contentEnd(lines, sec);
    const trailing = lines.slice(end, sec.to);
    const content = bodyLines(op.text);
    const leadBlank = sec.head >= 0 && (end > sec.from ? isBlank(lines[sec.from]) : true);
    const fresh = content.length ? [...(leadBlank ? [''] : []), ...content] : [];
    let tail = trailing;
    const before = [...lines.slice(0, sec.from), ...fresh];
    if (nextHeading && tail.length === 0 && before.length && !isBlank(before[before.length - 1])) tail = [''];
    const next = [...before, ...tail, ...lines.slice(sec.to)];
    return { body: joinBody({ ...parts, lines: next }), changed: true, summary: `replaced ${label} (${content.length} lines)` };
  }

  if (op.kind === 'remove') {
    const hits = listEntries(lines, sec).filter((e) => e.text.includes(op.match));
    if (hits.length === 0) {
      return { body: String(body), changed: false, summary: `no entry matching "${op.match}" in ${label}, nothing written` };
    }
    if (hits.length > 1) return { error: `ambiguous: ${hits.length} entries in ${label} contain "${op.match}"` };
    const h = hits[0];
    const next = [...lines.slice(0, h.start), ...lines.slice(h.end)];
    return { body: joinBody({ ...parts, lines: next }), changed: true, summary: `removed 1 entry from ${label}` };
  }

  return { error: `unknown op: ${op.kind}` };
}

// --- secret guard ------------------------------------------------------------

function guardCandidates() {
  return [
    path.join(__dirname, '..', 'hooks', 'trailhead-secret-guard.js'),
    path.join(__dirname, '..', '..', 'hooks', 'trailhead-secret-guard.js'),
  ];
}

// The shipped secret-guard module ({ scan }), or null when none is found. Plugin
// and Codex layouts keep it at ../hooks, npm Claude at ../../hooks.
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
  if (!guard || typeof guard.scan !== 'function') return 'secret-scan unavailable, use the prose fallback';
  try {
    const hit = guard.scan(text, {});
    return hit ? `secret detected (${hit}) in the text to write, nothing written` : null;
  } catch {
    return 'secret-scan unavailable, use the prose fallback';
  }
}

// --- gh boundary -------------------------------------------------------------

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const repoArgs = (repo) => (repo ? ['-R', repo] : []);

// One read of { body, updatedAt }; any failure is { error }.
function readOnce(issue, { gh, repo }) {
  const r = gh(['issue', 'view', String(issue), '--json', 'body,updatedAt', ...repoArgs(repo)]);
  if (r.status !== 0) return { error: `gh issue view #${issue} failed: ${firstLine(r.stderr) || 'exit ' + r.status}` };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { error: `gh issue view #${issue} returned unparseable JSON` }; }
  if (!data || typeof data.body !== 'string' || typeof data.updatedAt !== 'string') {
    return { error: `gh issue view #${issue} returned no body` };
  }
  if (data.body.replace(/\s/g, '').length === 0) return { error: `issue #${issue} has an empty body, refusing to rewrite it` };
  if (data.body.replace(/\s/g, '').length < DEGENERATE_MAX) return { error: `issue #${issue} has a degenerate body, refusing to rewrite it` };
  return { body: data.body, updatedAt: data.updatedAt };
}

// Read with one retry (fail-safe rule: a failed or degenerate read is a hard abort).
function readIssue(issue, opts) {
  const first = readOnce(issue, opts);
  return first.error ? readOnce(issue, opts) : first;
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) || '';
}

function resolveRepo(opts) {
  if (opts.repo) return opts.repo;
  const r = opts.gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const slug = r.status === 0 ? r.stdout.trim() : '';
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

const EDITS_QUERY = 'query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){userContentEdits{totalCount}}}}';

// The issue's edit-history count, or null when it cannot be read.
function editCount(issue, opts, slug = resolveRepo(opts)) {
  if (!slug) return null;
  const [owner, name] = slug.split('/');
  const r = opts.gh(['api', 'graphql', '-f', `query=${EDITS_QUERY}`, '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `i=${issue}`]);
  if (r.status !== 0) return null;
  try {
    const n = JSON.parse(r.stdout).data.repository.issue.userContentEdits.totalCount;
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

const norm = (s) => String(s).replace(/\r\n/g, '\n');

// Writes `text` with gh issue edit through a temp file that is always removed.
function ghWrite(issue, text, opts) {
  const dir = fs.mkdtempSync(path.join(opts.tmpdir || os.tmpdir(), 'trailhead-issue-body-'));
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, text);
    const r = opts.gh(['issue', 'edit', String(issue), '--body-file', file, ...repoArgs(opts.repo)]);
    return r.status === 0 ? null : `gh issue edit #${issue} failed: ${firstLine(r.stderr) || 'exit ' + r.status}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- guarded whole-body write ------------------------------------------------

// input: the new body (string) or a function (currentBody) => string | { error },
// re-applied once on a fresh body when the issue moved under us. opts: { gh, repo,
// guard, scanText, dryRun, tmpdir, firstEditDelta2 }. scanText is what the secret
// scan sees (default: the whole new body).
// Returns { ok: true, oldSize, newSize, dryRun? } or { ok: false, reason, conflict? }.
function guardedWrite(issue, input, rawOpts = {}) {
  const opts = { ...rawOpts, gh: rawOpts.gh || defaultGh, guard: rawOpts.guard === undefined ? loadGuard() : rawOpts.guard };
  const fail = (reason, extra) => ({ ok: false, reason, ...extra });
  const compute = typeof input === 'function' ? input : null;

  // The repo slug is resolved once per write (the graphql edit-count reads need it).
  const slug = opts.dryRun ? null : resolveRepo(opts);
  if (!opts.dryRun && !slug) return fail('cannot resolve the repository for the post-write check, nothing written');

  let cur = readIssue(issue, opts);
  if (cur.error) return fail(cur.error);
  let next;
  let baseline = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const made = compute ? compute(cur.body) : input;
    if (made && typeof made === 'object' && made.error) return fail(made.error);
    if (typeof made !== 'string' || made.trim() === '') return fail('the resulting body would be empty, nothing written');
    const problem = secretProblem(opts.scanText === undefined ? made : opts.scanText, opts.guard);
    if (problem) return fail(problem);
    // The edit-count baseline is read BEFORE the final updatedAt re-read: an edit
    // landing after the baseline either shows in the re-read (moved: re-apply or
    // abort) or in the post-write delta, never absorbed into the baseline.
    if (!opts.dryRun) {
      baseline = editCount(issue, opts, slug);
      if (baseline === null) return fail('could not read the issue edit count for the post-write check, nothing written');
    }
    const check = readIssue(issue, opts);
    if (check.error) return fail(check.error);
    if (check.updatedAt === cur.updatedAt) { next = made; break; }
    if (!compute) return fail(`issue #${issue} changed while preparing the write, nothing written`);
    if (attempt === 1) return fail(`issue #${issue} changed twice while preparing the write, nothing written`);
    cur = check;
  }

  const sizes = { oldSize: Buffer.byteLength(cur.body), newSize: Buffer.byteLength(next) };
  if (opts.dryRun) return { ok: true, dryRun: true, ...sizes };

  const err = ghWrite(issue, next, opts);
  if (err) return fail(err);

  const after = editCount(issue, opts, slug);
  const back = readOnce(issue, opts);
  if (after === null || back.error) {
    return fail(`written, but the post-write check could not run (${back.error || 'edit count unreadable'}): verify the issue body`);
  }
  const delta = after - baseline;
  const firstEdit2 = (opts.firstEditDelta2 === undefined ? FIRST_EDIT_DELTA2 : opts.firstEditDelta2) && baseline === 0;
  const cleanDelta = delta === 1 || (firstEdit2 && delta === 2);
  if (!cleanDelta || norm(back.body) !== norm(next)) {
    return fail(`conflict: a concurrent edit landed during the write, the overwritten text is in the issue's edit history: ${EDIT_HISTORY_HINT}`, { conflict: true });
  }
  return { ok: true, ...sizes };
}

// --- CLI ---------------------------------------------------------------------

const OPS = ['append', 'replace', 'remove'];

function parseArgs(argv) {
  const kind = argv[0];
  if (!OPS.includes(kind)) return { error: `usage: expected append, replace or remove, got: ${kind === undefined ? '(nothing)' : kind}` };
  const o = { kind, dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') { o.dryRun = true; continue; }
    if (!['--issue', '--repo', '--section', '--line', '--file', '--match'].includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--issue') {
      if (!/^[1-9]\d*$/.test(v)) return { error: `usage: --issue must be a positive integer, got: ${v}` };
      o.issue = Number(v);
    } else if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else o[flag.slice(2)] = v;
  }
  if (o.issue === undefined) return { error: 'usage: --issue is required' };
  if (!o.section) return { error: 'usage: --section is required' };
  const given = ['line', 'file', 'match'].filter((k) => o[k] !== undefined);
  const want = { append: 'line', replace: 'file', remove: 'match' }[kind];
  if (given.length !== 1 || given[0] !== want) return { error: `usage: ${kind} needs exactly --${want}` };
  if (kind === 'remove' && o.match === '') return { error: 'usage: --match must not be empty' };
  return o;
}

function main(argv, { gh, stdout, stderr, guard, tmpdir, firstEditDelta2 } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  let text;
  if (o.kind === 'replace') {
    try { text = fs.readFileSync(o.file, 'utf8'); } catch (e) { err.write(`usage: cannot read --file ${o.file}: ${e.message}\n`); return 2; }
  }
  const op = { kind: o.kind, section: o.section, line: o.line, text, match: o.match };
  const prefix = `issue #${o.issue}`;
  let summary = '';
  let unchanged = false;
  const compute = (body) => {
    const r = applyOp(body, op);
    if (r.error) return { error: r.error };
    summary = r.summary;
    if (!r.changed) { unchanged = true; return r.body; }
    unchanged = false;
    return r.body;
  };

  // Scan only what is inserted, not the whole body.
  const scanText = o.kind === 'append' ? o.line : o.kind === 'replace' ? text : '';
  const wrapped = (body) => compute(body);
  // A no-op remove must not write: resolve it on a plain read first.
  const result = noopFirst(o, wrapped, () => unchanged, { gh: gh || defaultGh, repo: o.repo, guard, tmpdir });
  if (result) {
    out.write(`${prefix}: ${summary}\n`);
    return 0;
  }
  const g = guardedWrite(o.issue, wrapped, { gh, repo: o.repo, guard, scanText: scanText === '' ? ' ' : scanText, dryRun: o.dryRun, tmpdir, firstEditDelta2 });
  if (!g.ok) { out.write(`aborted: ${g.reason}\n`); return 1; }
  if (g.dryRun) out.write(`${prefix}: dry-run: would have ${summary} (body ${g.oldSize} -> ${g.newSize} bytes), nothing written\n`);
  else out.write(`${prefix}: ${summary}\n`);
  return 0;
}

// For `remove`, a body with no matching entry is a reported no-op: detect it on a
// read before entering the write path so nothing is written. Returns true when the
// op is a no-op (summary already set by compute).
function noopFirst(o, compute, wasUnchanged, opts) {
  if (o.kind !== 'remove') return false;
  const cur = readIssue(o.issue, opts);
  if (cur.error) return false; // guardedWrite reports the read failure itself
  const r = compute(cur.body);
  return !(r && r.error) && wasUnchanged();
}

module.exports = { applyOp, readSection, defaultGh, PLACEHOLDER_RE, guardedWrite, loadGuard, main, parseArgs, readIssue, editCount, secretProblem, PREAMBLE };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
