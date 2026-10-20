#!/usr/bin/env node
'use strict';
// trailhead UAT follow-up finder (self-contained, ships in templates/ so it reaches
// every install channel). Tells an autonomous run whether a ticket's UAT follow-up
// already exists, so a resume reuses it instead of opening a second one. #281.
//
// CLI:
//   node trailhead-uat-followup.js find --parent <n> --repo <owner/name>
//
// Reads every `trailhead:uat` issue (open and closed) with the GraphQL list (not the
// search index, so a follow-up opened seconds earlier is seen) and keeps those whose
// body has a line starting `UAT of:` that points at the parent: a markdown link
// target https://github.com/<owner>/<name>/issues/<n> (same repo, exact number) or a
// bare `#<n>`. A mid-line mention is not a pointer. Only an OPEN follow-up is
// reusable: `reuse` is the lowest-numbered open one, null when none is open; closed
// ones are reported but never count. A read that fails, is unparseable, or hits the
// 1000 limit fails closed (the caller must not open a follow-up blind).
//
// Prints exactly one JSON line on stdout:
//   ok:    {"status":"ok","parent":n,"open":[{"number","title"}],"closed":[{"number","title"}],"reuse":<n>|null}
//   error: {"status":"error","reason":"..."}
// Exit 0 on ok, 1 on an error, 2 on a usage error (stderr).

const { spawnSync } = require('child_process');

const LIMIT = 1000;
const URL_RE = /https:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/issues\/(\d+)(?!\d)/gi;

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const byNumber = (a, b) => a.number - b.number;

function parseArgs(argv) {
  const cmd = argv[0];
  if (cmd !== 'find') return { error: `usage: expected find, got: ${cmd === undefined ? '(nothing)' : cmd}` };
  const o = { cmd, parent: null, repo: null };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--parent' && flag !== '--repo') return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else {
      if (!/^[1-9]\d*$/.test(v)) return { error: `usage: --parent must be a positive integer, got: ${v}` };
      o.parent = Number(v);
    }
  }
  if (!o.repo) return { error: 'usage: find requires --repo' };
  if (!o.parent) return { error: 'usage: find requires --parent' };
  return o;
}

// Pure: does a `UAT of:` line of the body point at issue `parent` of `repo`?
function pointsAt(body, parent, repo) {
  const want = repo.toLowerCase();
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const m = /^UAT of:(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1];
    const urls = [...rest.matchAll(URL_RE)];
    if (urls.length) {
      if (urls.some((u) => `${u[1]}/${u[2]}`.toLowerCase() === want && Number(u[3]) === parent)) return true;
      continue;
    }
    const bare = [...rest.matchAll(/(?:^|[^\w/])#(\d+)\b/g)];
    if (bare.some((b) => Number(b[1]) === parent)) return true;
  }
  return false;
}

function main(argv, { gh, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason) => { emit({ status: 'error', reason }); return 1; };

  const r = run(['issue', 'list', '--label', 'trailhead:uat', '--state', 'all', '--limit', String(LIMIT), '--json', 'number,title,state,body', '-R', o.repo]);
  if (r.status !== 0) return fail(`gh issue list failed: ${firstLine(r.stderr) || 'exit ' + r.status}`);
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return fail('gh issue list returned unparseable JSON'); }
  if (!Array.isArray(rows)) return fail('gh issue list returned unexpected JSON');
  if (rows.length >= LIMIT) return fail(`incomplete list: the trailhead:uat read hit the ${LIMIT} limit`);

  const mine = rows.filter((i) => pointsAt(i.body, o.parent, o.repo)).map((i) => ({ number: i.number, title: i.title, state: String(i.state || '').toUpperCase() }));
  const pick = (open) => mine.filter((i) => (i.state === 'OPEN') === open).sort(byNumber).map(({ number, title }) => ({ number, title }));
  const open = pick(true);
  emit({ status: 'ok', parent: o.parent, open, closed: pick(false), reuse: open.length ? open[0].number : null });
  return 0;
}

module.exports = { main, parseArgs, pointsAt };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
