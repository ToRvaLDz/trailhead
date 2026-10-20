#!/usr/bin/env node
'use strict';
// trailhead UAT follow-up finder (self-contained, ships in templates/ so it reaches
// every install channel). Tells an autonomous run whether a ticket's UAT follow-up
// already exists, so a resume reuses it instead of opening a second one. #281.
//
// CLI:
//   node trailhead-uat-followup.js find --parent <n> --repo <owner/name>
//
// Reads every `trailhead:uat` issue (open and closed) with a direct GraphQL query
// (`gh api graphql`, `repository.issues`), paginated here 100 at a time. It does not
// use `gh issue list --label`: gh turns a label filter into a search query, and the
// search index lags, so a follow-up opened seconds earlier would be missed. It keeps
// the issues whose body has a line starting `UAT of:` that points at the parent: a
// markdown link target https://github.com/<owner>/<name>/issues/<n> (same repo, exact
// number) or a bare `#<n>`. A mid-line mention is not a pointer. Only an OPEN
// follow-up is reusable: `reuse` is the lowest-numbered open one, null when none is
// open; closed ones are reported but never count. A read that fails, is unparseable,
// carries GraphQL errors, has an unexpected shape, or exceeds the page cap (100 pages of 100, so 10,000 issues) fails
// closed (the caller must not open a follow-up blind).
//
// Prints exactly one JSON line on stdout:
//   ok:    {"status":"ok","parent":n,"open":[{"number","title"}],"closed":[{"number","title"}],"reuse":<n>|null}
//   error: {"status":"error","reason":"..."}
// Exit 0 on ok, 1 on an error, 2 on a usage error (stderr).

const { spawnSync } = require('child_process');

const MAX_PAGES = 100; // 100 pages x 100 issues
const QUERY = 'query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,labels:["trailhead:uat"],states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title state body} pageInfo{hasNextPage endCursor}}}}';
const URL_RE = /https:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/issues\/(\d+)(?![\w])/gi;

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

  const [owner, name] = o.repo.split('/');
  const rows = [];
  let after = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) return fail(`incomplete read: more than ${MAX_PAGES} pages of trailhead:uat issues`);
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
    if (after !== null) args.push('-f', `after=${after}`);
    const r = run(args);
    if (r.status !== 0) return fail(`gh api graphql failed: ${firstLine(r.stderr) || 'exit ' + r.status}`);
    let body;
    try { body = JSON.parse(r.stdout); } catch { return fail('gh api graphql returned unparseable JSON'); }
    if (!body || typeof body !== 'object') return fail('gh api graphql returned unexpected JSON');
    if (Array.isArray(body.errors) && body.errors.length) return fail(`graphql errors: ${firstLine(body.errors[0] && body.errors[0].message) || 'unknown'}`);
    const repo = body.data && body.data.repository;
    if (!repo) return fail('repository not found in the graphql response');
    const issues = repo.issues;
    if (!issues || !Array.isArray(issues.nodes)) return fail('graphql response has no issues.nodes');
    const info = issues.pageInfo;
    if (!info || typeof info.hasNextPage !== 'boolean') return fail('graphql response has no pageInfo');
    rows.push(...issues.nodes.filter((n) => n && typeof n === 'object'));
    if (!info.hasNextPage) break;
    if (typeof info.endCursor !== 'string' || !info.endCursor) return fail('graphql pageInfo has hasNextPage without an endCursor');
    after = info.endCursor;
  }

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
