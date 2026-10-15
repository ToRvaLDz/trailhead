#!/usr/bin/env node
'use strict';
// trailhead UAT backfill (self-contained, ships in templates/ so it reaches every
// install channel). One-time, idempotent migration: tags every open ticket whose
// body has a `UAT of:` line with the `trailhead:uat` label, so a pending UAT
// follow-up opened before the label existed is still findable. #261.
//
// CLI:
//   node trailhead-uat-backfill.js [--repo <owner/name>] [--marker <path>]
// --marker makes the run once per clone: a present marker exits `skipped` with no
// `gh` call; the helper writes it only on a clean run (label confirmed, list read
// ok, no failed edit).
//
// Prints exactly one JSON line on stdout:
//   {"status":"ok"|"skipped"|"error","tagged":[n,...],"failed":[n,...],"reason":"..."}
// Exit 0 on ok or skipped, 1 on an error, 2 on a usage error (stderr).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'trailhead:uat';
const COLOR = 'BFD4F2';
const DESCRIPTION = 'Pending UAT: an acceptance test still to run';
const LIMIT = 1000;
// A line that starts with `UAT of:` (a mid-line mention is not a pointer).
const UAT_LINE_RE = /^UAT of:/m;

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

function parseArgs(argv) {
  const o = { repo: null, marker: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--repo' && flag !== '--marker') return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else {
      o.marker = v;
    }
  }
  return o;
}

const names = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name));

// Ensures the label exists: idempotent create, then a confirming read. A create
// failure is only "already exists" when the label is actually there.
function ensureLabel(gh, rArgs) {
  gh(['label', 'create', LABEL, '--color', COLOR, '--description', DESCRIPTION, ...rArgs]);
  const r = gh(['label', 'list', '--search', LABEL, '--json', 'name', ...rArgs]);
  if (r.status !== 0) return `cannot confirm the ${LABEL} label: ${firstLine(r.stderr) || 'exit ' + r.status}`;
  let list;
  try { list = JSON.parse(r.stdout); } catch { return `cannot confirm the ${LABEL} label: unparseable label list`; }
  return Array.isArray(list) && names(list).includes(LABEL) ? null : `the ${LABEL} label does not exist and could not be created`;
}

function main(argv, { gh, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason) => { emit({ status: 'error', tagged: [], failed: [], reason }); return 1; };

  if (o.marker && fs.existsSync(o.marker)) { emit({ status: 'skipped', tagged: [], failed: [] }); return 0; }

  const rArgs = o.repo ? ['-R', o.repo] : [];
  const problem = ensureLabel(run, rArgs);
  if (problem) return fail(problem);

  const list = run(['issue', 'list', '--state', 'open', '--search', `"UAT of:" in:body -label:${LABEL}`, '--limit', String(LIMIT), '--json', 'number,body,labels', ...rArgs]);
  if (list.status !== 0) return fail(`gh issue list failed: ${firstLine(list.stderr) || 'exit ' + list.status}`);
  let issues;
  try { issues = JSON.parse(list.stdout); } catch { return fail('gh issue list returned unparseable JSON'); }
  if (!Array.isArray(issues)) return fail('gh issue list returned unexpected JSON');

  const tagged = [];
  const failed = [];
  for (const i of issues) {
    if (names(i.labels).includes(LABEL)) continue;
    if (!UAT_LINE_RE.test(String(i.body || '').replace(/\r/g, ''))) continue;
    const r = run(['issue', 'edit', String(i.number), '--add-label', LABEL, ...rArgs]);
    (r.status === 0 ? tagged : failed).push(i.number);
  }

  let reason;
  if (o.marker && failed.length === 0) {
    try {
      fs.mkdirSync(path.dirname(o.marker), { recursive: true });
      fs.writeFileSync(o.marker, new Date().toISOString() + '\n');
    } catch (e) {
      reason = `marker not written: ${e && e.message ? e.message : String(e)}`;
    }
  }
  emit(reason ? { status: 'ok', tagged, failed, reason } : { status: 'ok', tagged, failed });
  return 0;
}

module.exports = { main, parseArgs, UAT_LINE_RE };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
