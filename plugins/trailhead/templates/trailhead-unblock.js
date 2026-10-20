#!/usr/bin/env node
'use strict';
// trailhead unblock helper (self-contained, ships in templates/ so it reaches every
// install channel). After an autonomous run closes a ticket, removes `trailhead:blocked`
// from every open dependent whose blockers are now all closed, so the next frontier
// query returns it. #286.
//
// CLI:
//   node trailhead-unblock.js --issue <n> --repo <owner/name>
//
// Reads the closed ticket's dependents (`dependencies/blocking`), and for each OPEN
// dependent that carries `trailhead:blocked` reads its `blocked_by`; when every blocker
// is closed it removes the label. Reads are paginated: `gh api --paginate --jq` prints
// one JSON object per line across every page, so a long list is read whole. A dependent
// without the label, or a closed one, is skipped, so a retry is idempotent. The first
// failed or unparseable gh step stops the helper: nothing further is edited.
//
// Prints exactly one JSON line on stdout:
//   ok:    {"status":"ok","unblocked":[n...],"stillBlocked":[{"issue":n,"openBlockers":[...]}]}
//   error: {"status":"error","reason":"..."}
// Exit 0 on ok, 1 on an error, 2 on a usage error (stderr).

const { spawnSync } = require('child_process');

const LABEL = 'trailhead:blocked';

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

function parseArgs(argv) {
  const o = { issue: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--issue' && flag !== '--repo') return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else {
      if (!/^[1-9]\d*$/.test(v)) return { error: `usage: --issue must be a positive integer, got: ${v}` };
      o.issue = Number(v);
    }
  }
  if (!o.repo) return { error: 'usage: requires --repo' };
  if (!o.issue) return { error: 'usage: requires --issue' };
  return o;
}

// One JSON object per line -> { items } or { error }.
function parseLines(text, what) {
  const items = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { return { error: `${what} returned unparseable JSON` }; }
    if (!j || typeof j !== 'object') return { error: `${what} returned unexpected JSON` };
    items.push(j);
  }
  return { items };
}

// Paginated read of a dependency list for issue n. { items } or { error }.
function readList(run, o, n, kind, jq) {
  const what = `gh api dependencies/${kind} of #${n}`;
  const r = run(['api', '--paginate', `repos/${o.repo}/issues/${n}/dependencies/${kind}`, '--jq', jq]);
  if (r.status !== 0) return { error: `${what} failed: ${firstLine(r.stderr) || 'exit ' + r.status}` };
  return parseLines(r.stdout, what);
}

const isOpen = (x) => String(x.state || '').toLowerCase() === 'open';

function main(argv, { gh, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason) => { emit({ status: 'error', reason }); return 1; };

  const deps = readList(run, o, o.issue, 'blocking', '.[] | {number, state, labels: [.labels[].name]}');
  if (deps.error) return fail(deps.error);

  const unblocked = [];
  const stillBlocked = [];
  for (const d of deps.items) {
    const labels = Array.isArray(d.labels) ? d.labels : [];
    if (!isOpen(d) || !labels.includes(LABEL)) continue;
    const blockers = readList(run, o, d.number, 'blocked_by', '.[] | {number, state}');
    if (blockers.error) return fail(blockers.error);
    const open = blockers.items.filter(isOpen).map((b) => b.number);
    if (open.length) { stillBlocked.push({ issue: d.number, openBlockers: open }); continue; }
    const r = run(['issue', 'edit', String(d.number), '--remove-label', LABEL, '-R', o.repo]);
    if (r.status !== 0) return fail(`gh issue edit (remove label) of #${d.number} failed: ${firstLine(r.stderr) || 'exit ' + r.status}`);
    unblocked.push(d.number);
  }
  emit({ status: 'ok', unblocked, stillBlocked });
  return 0;
}

module.exports = { main, parseArgs, parseLines };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
