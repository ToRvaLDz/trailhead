#!/usr/bin/env node
'use strict';
// trailhead capture helper (self-contained, ships in templates/ so it reaches every
// install channel). Scriptable capture for automations (CI, cron, bots): opens a bug,
// todo, seed or idea with the full label wiring, without a chat session. #332.
//
// CLI:
//   node trailhead-capture.js --type bug|todo|idea|seed --title <t> \
//        (--body <b> | --body-file <path|->) --repo <owner/name> \
//        [--map <n> | --of <n>] [--trigger <text>] [--unverified] \
//        [--dedupe-key <key>] [--no-dashboard]
//   --trigger is required for seed and rejected otherwise. --unverified is rejected for idea.
//   --of is only for bug and is exclusive with --map (the ticket inherits the origin's map or the whiteboard).
//   --dedupe-key matches ^[A-Za-z0-9._:-]{1,100}$ and makes the run idempotent.
//
// Flow (nothing is created on any pre-check failure): trust check, destination, dedupe,
// secret-scan of the exact payload, create (labels ride in the one create call), label
// read-back, post-create trust verification when the identity was unreadable, native
// sub-issue edge (map tickets), dashboard refresh (whiteboard tickets).
//
// Prints exactly one JSON line on stdout:
//   created:  {"status":"created","issue","url","type","destination","labels","trust","edge"?,"dashboard","warnings"}   exit 0
//   existing: {"status":"existing","issue","url","dedupeKey"}                                          exit 0
//   partial:  {"status":"partial","issue","url",...,"edge":"failed","warnings"}                        exit 3
//   error:    {"status":"error","reason",...} ("trust":"insufficient" on a trust failure)             exit 1
//   usage:    {"status":"usage","reason"} (also on stderr)                                              exit 2
// A caller checking only the exit status therefore never mistakes a partial for success.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TYPES = ['bug', 'todo', 'idea', 'seed'];
const TYPE_LABEL = { bug: 'trailhead:bug', todo: 'trailhead:build', seed: 'trailhead:build' };
const ALLOWLIST_VAR = 'TRAILHEAD_LABEL_ALLOWLIST';
const ACTIONS_BOT = 'github-actions[bot]';
const SEARCH_CAP = 1000;
const KEY_RE = /^[A-Za-z0-9._:-]{1,100}$/;

function defaultGh(args, input) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const failText = (r) => firstLine(r.stderr) || 'exit ' + r.status;
const markerFor = (key) => `<!-- trailhead-dedupe: ${key} -->`;

// --- secret guard (same approach as trailhead-needs-you.js) -------------------

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
  if (!guard || typeof guard.scan !== 'function') return 'secret-scan unavailable, nothing created';
  try {
    const hit = guard.scan(text, {});
    return hit ? `secret detected (${hit}) in the payload, nothing created` : null;
  } catch {
    return 'secret-scan unavailable, nothing created';
  }
}

// --- args ---------------------------------------------------------------------

const VALUE_FLAGS = ['--type', '--title', '--body', '--body-file', '--repo', '--map', '--of', '--trigger', '--dedupe-key'];
const BOOL_FLAGS = ['--unverified', '--no-dashboard'];

function parseArgs(argv) {
  const o = { type: null, title: null, body: null, bodyFile: null, repo: null, map: null, of: null, trigger: null, unverified: false, dedupeKey: null, noDashboard: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOL_FLAGS.includes(flag)) {
      if (flag === '--unverified') o.unverified = true; else o.noDashboard = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--type') {
      if (!TYPES.includes(v)) return { error: `usage: --type must be one of ${TYPES.join('|')}, got: ${v}` };
      o.type = v;
    } else if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else if (flag === '--map' || flag === '--of') {
      if (!/^[1-9]\d*$/.test(v)) return { error: `usage: ${flag} must be a positive integer, got: ${v}` };
      o[flag === '--map' ? 'map' : 'of'] = Number(v);
    } else if (flag === '--dedupe-key') {
      if (!KEY_RE.test(v)) return { error: `usage: --dedupe-key must match ${KEY_RE}, got: ${v}` };
      o.dedupeKey = v;
    } else if (flag === '--title') o.title = v;
    else if (flag === '--body') o.body = v;
    else if (flag === '--body-file') o.bodyFile = v;
    else o.trigger = v;
  }
  if (!o.type) return { error: 'usage: --type is required' };
  if (o.title === null || !o.title.trim()) return { error: 'usage: a non-empty --title is required' };
  if (!o.repo) return { error: 'usage: --repo is required' };
  if (o.body !== null && o.bodyFile !== null) return { error: 'usage: --body and --body-file are mutually exclusive' };
  if (o.body === null && o.bodyFile === null) return { error: 'usage: one of --body or --body-file is required' };
  if (o.type === 'seed' && (o.trigger === null || !o.trigger.trim())) return { error: 'usage: seed requires a non-empty --trigger' };
  if (o.type !== 'seed' && o.trigger !== null) return { error: 'usage: --trigger is only for --type seed' };
  if (o.of !== null && o.type !== 'bug') return { error: 'usage: --of is only for --type bug' };
  if (o.unverified && o.type === 'idea') return { error: 'usage: --unverified is only for ticket types (fog is already off the frontier)' };
  if (o.of !== null && o.map !== null) return { error: 'usage: --of and --map are mutually exclusive' };
  return o;
}

// --- pure payload ---------------------------------------------------------------

// { title, body, labels, destination } from the resolved inputs. map: { number, title, url } | null,
// of: { title, url } | null. Pure.
function buildIssue({ type, title, body, map, of, trigger, unverified, dedupeKey }) {
  const isIdea = type === 'idea';
  const labels = isIdea ? ['trailhead:fog'] : ['trailhead:ticket', TYPE_LABEL[type]];
  if (type === 'seed') labels.push('trailhead:seed', 'trailhead:blocked');
  if (!isIdea) labels.push(map ? `trailhead:map-${map.number}` : 'trailhead:whiteboard');
  if (!isIdea && unverified) labels.push('trailhead:unverified');

  const parts = [];
  if (map) parts.push(`Parent: [${map.title}](${map.url})`);
  if (of) parts.push(`Regression of: [${of.title}](${of.url})`);
  if (type === 'seed') parts.push(`Trigger: ${trigger.trim()}`);
  parts.push(String(body).replace(/\s+$/, ''));
  if (type === 'seed') parts.push(`## Blocked by\n\n- Trigger: ${trigger.trim()}`);
  if (dedupeKey) parts.push(markerFor(dedupeKey));
  const destination = map ? `map-${map.number}` : isIdea ? 'none' : 'whiteboard';
  return { title: title.trim(), body: parts.join('\n\n') + '\n', labels, destination };
}

// The same parsing expression as templates/trailhead-label-guard.yml (parity is tested).
function parseAllowlist(s) {
  return (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

// --- gh steps ---------------------------------------------------------------------

function parseJson(r) {
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// True when the login has write, maintain or admin on the repo. A failed read counts as none.
function hasWrite(run, repo, login) {
  const j = parseJson(run(['api', `repos/${repo}/collaborators/${login}/permission`]));
  if (!j) return false;
  return ['admin', 'write'].includes(j.permission) || j.role_name === 'maintain';
}

// The repository's own allowlist (the source the guard Action reads), never the local env.
function readAllowlist(run, repo) {
  const r = run(['api', `repos/${repo}/actions/variables/${ALLOWLIST_VAR}`, '--jq', '.value']);
  return r.status === 0 ? parseAllowlist(r.stdout.trim()) : [];
}

// { trust: 'ok'|'allowlisted'|'pending'|'insufficient', login? }. The env argument is accepted
// and deliberately ignored: a caller-controlled allowlist would defeat the check.
function checkTrust(run, repo) {
  const who = run(['api', 'user', '--jq', '.login']);
  const login = who.status === 0 ? who.stdout.trim() : '';
  if (!login) return { trust: 'pending' };
  if (hasWrite(run, repo, login)) return { trust: 'ok', login };
  if (readAllowlist(run, repo).includes(login.toLowerCase())) return { trust: 'allowlisted', login };
  return { trust: 'insufficient', login };
}

// An open `trailhead:map` -> { number, title, url }, else { error }.
function readMap(run, repo, n) {
  const j = parseJson(run(['issue', 'view', String(n), '--json', 'state,title,url,labels', '-R', repo]));
  if (!j) return { error: `cannot read map #${n}` };
  const names = (j.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  if (String(j.state).toUpperCase() !== 'OPEN') return { error: `map #${n} is not open` };
  if (!names.includes('trailhead:map')) return { error: `#${n} is not a trailhead:map` };
  return { number: n, title: String(j.title), url: String(j.url) };
}

// { map, of? } with map null for the whiteboard, or { error }.
function resolveDestination(run, repo, { map, of }) {
  if (map) {
    const m = readMap(run, repo, map);
    return m.error ? { error: m.error } : { map: m };
  }
  if (of) {
    const unresolved = { error: 'origin destination unresolved' };
    const j = parseJson(run(['issue', 'view', String(of), '--json', 'title,url,labels', '-R', repo]));
    if (!j) return unresolved;
    const names = (j.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
    const maps = names.filter((n) => /^trailhead:map-[1-9]\d*$/.test(n));
    const origin = { title: String(j.title), url: String(j.url) };
    if (maps.length === 1 && !names.includes('trailhead:whiteboard')) {
      const m = readMap(run, repo, Number(maps[0].slice('trailhead:map-'.length)));
      return m.error ? unresolved : { map: m, of: origin };
    }
    if (maps.length === 0 && names.includes('trailhead:whiteboard')) return { map: null, of: origin };
    return unresolved;
  }
  return { map: null };
}

// Lines of `gh api --paginate ... --jq '... | tojson'`: one JSON document per line.
function jsonLines(r) {
  if (r.status !== 0) return null;
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { return null; }
  }
  return out;
}

// { issue, url } for an open issue carrying the exact marker, null for none, { error } on failure.
function findDuplicate(run, repo, key) {
  const marker = markerFor(key);
  const s = run(['issue', 'list', '-R', repo, '--state', 'open', '--search', `"trailhead-dedupe: ${key}" in:body`, '--json', 'number,url,body', '--limit', String(SEARCH_CAP)]);
  const list = parseJson(s);
  if (!Array.isArray(list)) return { error: `dedupe search failed: ${failText(s)}` };
  const hit = list.find((i) => String(i.body || '').includes(marker));
  if (hit) return { issue: hit.number, url: hit.url };
  if (list.length < SEARCH_CAP) return null;
  // A search at its cap cannot be trusted to be complete: scan every open issue.
  const scan = run(['api', '--paginate', `repos/${repo}/issues?state=open&per_page=100`, '--jq', '.[] | {number, html_url, body, pr: (.pull_request != null)} | tojson']);
  const rows = jsonLines(scan);
  if (!rows) return { error: `dedupe scan failed: ${failText(scan)}` };
  const found = rows.find((i) => !i.pr && String(i.body || '').includes(marker));
  return found ? { issue: found.number, url: found.html_url } : null;
}

// Waits between reads of the issue events right after create: the endpoint can briefly return a
// successful but empty (or partial) list before the labeled events are visible.
const EVENTS_BACKOFF_MS = [1000, 2000, 4000];

// { label, actor } of each trailhead:* labeled event on the issue, or null when unreadable.
function labelEvents(run, repo, n) {
  const r = run(['api', '--paginate', `repos/${repo}/issues/${n}/events`, '--jq', '.[] | select(.event == "labeled") | {label: .label.name, actor: .actor.login} | tojson']);
  const rows = jsonLines(r);
  if (!rows) return null;
  return rows.filter((e) => String(e.label).startsWith('trailhead:')).map((e) => ({ label: String(e.label), actor: String(e.actor) }));
}

// Decides one actor's trust: 'actions-token' | 'allowlisted' | 'ok' | null.
function actorTrust(run, repo, actor, allow) {
  if (actor === ACTIONS_BOT) return 'actions-token';
  if (allow.includes(actor.toLowerCase())) return 'allowlisted';
  return hasWrite(run, repo, actor) ? 'ok' : null;
}

// Post-create trust for an unreadable identity: re-reads the events (bounded backoff) until every
// expected trailhead:* label shows a labeled event, then every actor who applied one must be one the
// guard Action never strips. 'actions-token' | 'allowlisted' | 'ok', { bad: actor }, or { error }.
function verifyActors(run, repo, n, expected, nap) {
  let allow = null;
  const rank = { 'actions-token': 0, allowlisted: 1, ok: 2 };
  const trusts = new Map();
  let events = null;
  for (let attempt = 0; attempt <= EVENTS_BACKOFF_MS.length; attempt++) {
    if (attempt) nap(EVENTS_BACKOFF_MS[attempt - 1]);
    events = labelEvents(run, repo, n);
    if (!events) continue;
    // A bad actor seen on any read fails at once.
    for (const actor of new Set(events.map((e) => e.actor))) {
      if (trusts.has(actor)) continue;
      if (!allow) allow = readAllowlist(run, repo);
      const t = actorTrust(run, repo, actor, allow);
      if (!t) return { bad: actor };
      trusts.set(actor, t);
    }
    if (expected.every((l) => events.some((e) => e.label === l))) {
      let result = 'actions-token';
      for (const t of trusts.values()) if (rank[t] > rank[result]) result = t;
      return { trust: result };
    }
  }
  if (!events) return { error: 'the issue events could not be read, so who applied the labels is unverified' };
  const unseen = expected.filter((l) => !events.some((e) => e.label === l));
  return { error: `no visible labeled event for ${unseen.join(', ')}, so who applied the labels is unverified` };
}

function readBody(o, stdin) {
  if (o.body !== null) return o.body;
  try {
    if (o.bodyFile === '-') return stdin !== undefined ? stdin : fs.readFileSync(0, 'utf8');
    return fs.readFileSync(o.bodyFile, 'utf8');
  } catch (e) {
    return { error: `cannot read the body: ${e.message}` };
  }
}

function main(argv, { gh, guard, stdout, stderr, sleep, dashboard, stdin } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const o = parseArgs(argv || []);
  if (o.error) { emit({ status: 'usage', reason: o.error }); err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const nap = sleep || defaultSleep;
  const fail = (reason, extra = {}) => { emit({ status: 'error', reason, ...extra }); return 1; };
  const repo = o.repo;

  const body = readBody(o, stdin);
  if (body && typeof body === 'object') return fail(body.error);

  // 2. trust (pre-create)
  const tr = checkTrust(run, repo);
  if (tr.trust === 'insufficient') {
    return fail(`${tr.login} lacks write access and is not in the repository allowlist (${ALLOWLIST_VAR}): the label guard would strip the labels`, { trust: 'insufficient' });
  }
  let trust = tr.trust;

  // 3. destination
  const dest = resolveDestination(run, repo, o);
  if (dest.error) return fail(dest.error);

  // 4. dedupe
  if (o.dedupeKey) {
    const dup = findDuplicate(run, repo, o.dedupeKey);
    if (dup && dup.error) return fail(dup.error);
    if (dup) { emit({ status: 'existing', issue: dup.issue, url: dup.url, dedupeKey: o.dedupeKey }); return 0; }
  }

  // 5. build and secret-scan exactly the payload that will be sent
  const built = buildIssue({ type: o.type, title: o.title, body, map: dest.map, of: dest.of, trigger: o.trigger, unverified: o.unverified, dedupeKey: o.dedupeKey });
  const problem = secretProblem(`${built.title}\n\n${built.body}`, guard === undefined ? loadGuard() : guard);
  if (problem) return fail(problem);

  // 6. create
  const isTicket = o.type !== 'idea';
  if (isTicket && !dest.map) run(['label', 'create', 'trailhead:whiteboard', '--color', 'C5DEF5', '--description', 'Loose ticket, no map', '-R', repo]);
  const c = run(['issue', 'create', '-R', repo, '--title', built.title, '--label', built.labels.join(','), '--body-file', '-'], built.body);
  if (c.status !== 0) return fail(`gh issue create failed: ${failText(c)}`);
  const m = /\/issues\/(\d+)\s*$/.exec(c.stdout.trim());
  if (!m) return fail('gh issue create printed no issue URL');
  const issue = Number(m[1]);
  const url = c.stdout.trim().split('\n').pop().trim();
  const made = { issue, url };

  // 7. read-back
  const rb = parseJson(run(['issue', 'view', String(issue), '--json', 'labels', '-R', repo]));
  if (!rb) return fail('cannot read back the created issue labels', made);
  const have = (rb.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  const missing = built.labels.filter((l) => !have.includes(l));
  if (missing.length) return fail(`labels missing: ${missing.join(', ')}`, made);

  // 7b. unreadable identity: verify who applied the labels
  if (trust === 'pending') {
    const expected = built.labels.filter((l) => l.startsWith('trailhead:'));
    const v = verifyActors(run, repo, issue, expected, nap);
    if (v.error) return fail(v.error, { trust: 'insufficient', ...made });
    if (!v.trust) return fail(`labels applied by ${v.bad} will be stripped by the label guard`, { trust: 'insufficient', ...made });
    trust = v.trust;
  }

  // 8. native edge for a map ticket
  const warnings = [];
  const result = { status: 'created', ...made, type: o.type, destination: built.destination, labels: built.labels, trust };
  if (isTicket && dest.map) {
    let edge = false;
    for (let attempt = 0; attempt < 2 && !edge; attempt++) {
      if (attempt) nap(1000);
      const id = run(['api', `repos/${repo}/issues/${issue}`, '--jq', '.id']);
      if (id.status !== 0 || !id.stdout.trim()) continue;
      const e = run(['api', '--method', 'POST', `repos/${repo}/issues/${dest.map.number}/sub_issues`, '-F', `sub_issue_id=${id.stdout.trim()}`]);
      edge = e.status === 0;
    }
    if (!edge) {
      warnings.push(`native sub-issue edge to map #${dest.map.number} failed (e.g. the 100 sub-issue cap); the ticket keeps its trailhead:map-${dest.map.number} label so it stays on the frontier; repair it with the trailhead prune command`);
      result.status = 'partial';
      result.edge = 'failed';
    } else {
      result.edge = 'ok';
    }
  }

  // 10. dashboard: only for a whiteboard ticket
  if (!isTicket || dest.map) result.dashboard = 'not-applicable';
  else if (o.noDashboard) result.dashboard = 'skipped';
  else {
    const sink = { write: () => true };
    const dash = dashboard || require('./trailhead-dashboard.js');
    let code = 1;
    try { code = dash.main(['--repo', repo, '--update-only'], { gh: run, stdout: sink, stderr: sink }); } catch { code = 1; }
    if (code === 0) result.dashboard = 'refreshed';
    else { result.dashboard = 'failed'; warnings.push('the dashboard refresh failed; refresh it with the trailhead dashboard command'); }
  }
  result.warnings = warnings;
  emit(result);
  return result.status === 'partial' ? 3 : 0;
}

module.exports = { main, parseArgs, buildIssue, parseAllowlist, checkTrust, resolveDestination, findDuplicate, loadGuard, secretProblem };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
