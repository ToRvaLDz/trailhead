#!/usr/bin/env node
'use strict';
// trailhead inbox needs-info classifier (self-contained, ships in templates/ so it
// reaches every install channel). Read-only: never writes to the tracker. #354.
//
// An inbox issue parked with `trailhead:needs-info` waits on its reporter. This
// helper sorts the parked issues so the inbox protocol can act on them:
//   answered  the reporter commented strictly after the latest label event
//   timedOut  no answer and at least N whole days since the label
//   waiting   no answer yet, inside the window
//   unknown   a read failed, no label event, or no usable reporter identity
//
// CLI:
//   node trailhead-inbox-needs-info.js --repo <owner/name> --config-root <project root>
// N comes from `inbox.needs_info_days` (project config over the global one, default 14).
//
// Prints exactly one JSON line on stdout:
//   {status, days, answered, timedOut, waiting, unknown, warnings}
// Exit 0 on ok, 1 on status error (the list read failed), 2 on a usage error (stderr).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { gitEnv } = require('./trailhead-git-env.js');

const LABEL = 'trailhead:needs-info';
const KEY = 'inbox.needs_info_days';
const DEFAULT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

function parseArgs(argv) {
  const o = { repo: null, configRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--repo' && flag !== '--config-root') return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else {
      o.configRoot = v;
    }
  }
  if (!o.repo) return { error: 'usage: missing --repo <owner/name>' };
  if (!o.configRoot) return { error: 'usage: missing --config-root <project root>' };
  return o;
}

// Lines of `gh api --paginate ... --jq '... | tojson'`: one JSON document per line.
// Any non-zero exit discards the whole read: a later page can fail after earlier ones printed.
function jsonLines(r) {
  if (r.status !== 0) return null;
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { return null; }
  }
  return out;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function globalConfigPath(env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

// { found, value } for the key in one parsed file: the flat key wins over the nested one.
function pick(cfg) {
  if (has(cfg, KEY)) return { found: true, value: cfg[KEY] };
  if (isObject(cfg.inbox) && has(cfg.inbox, 'needs_info_days')) return { found: true, value: cfg.inbox.needs_info_days };
  return { found: false };
}

// Days from the nearest valid layer. A bad layer warns and falls to the next one: a timeout only
// ever produces an offer the maintainer confirms.
function resolveDays(root, env, fs_, warnings) {
  for (const file of [path.join(root, '.trailhead', 'config.json'), globalConfigPath(env)]) {
    let cfg;
    try {
      cfg = JSON.parse(fs_.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      warnings.push(e instanceof SyntaxError ? `${file} is not valid JSON; ignored` : `cannot read ${file}; ignored`);
      continue;
    }
    if (!isObject(cfg)) { warnings.push(`${file} is not a JSON object; ignored`); continue; }
    const hit = pick(cfg);
    if (!hit.found) continue;
    if (Number.isInteger(hit.value) && hit.value > 0) return hit.value;
    warnings.push(`${KEY} in ${file} must be a positive integer; ignored`);
  }
  return DEFAULT_DAYS;
}

const usable = (login) => typeof login === 'string' && login !== '' && login.toLowerCase() !== 'ghost';

function main(argv, { gh, now, stdout, stderr, env, fs: fs_ } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const nowMs = (now ? now() : new Date()).getTime();
  const warnings = [];
  const days = resolveDays(o.configRoot, env || process.env, fs_ || fs, warnings);
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');

  const list = jsonLines(run(['api', '--paginate', `repos/${o.repo}/issues?labels=${LABEL}&state=open&per_page=100`, '--jq', '.[] | select(.pull_request == null) | {number, title, author: .user.login} | tojson']));
  if (!list) {
    emit({ status: 'error', days, answered: [], timedOut: [], waiting: [], unknown: [], warnings, reason: 'could not read the parked issues' });
    return 1;
  }

  const res = { status: 'ok', days, answered: [], timedOut: [], waiting: [], unknown: [], warnings };
  for (const i of list) {
    const { number, title } = i;
    const unknown = (reason) => res.unknown.push({ number, title, reason });
    const events = jsonLines(run(['api', '--paginate', `repos/${o.repo}/issues/${number}/events`, '--jq', `.[] | select(.event == "labeled" and .label.name == "${LABEL}") | {at: .created_at} | tojson`]));
    if (!events) { unknown('could not read the label events'); continue; }
    const times = events.map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
    if (!times.length) { unknown('no label event found'); continue; }
    if (!usable(i.author)) { unknown('the reporter has no usable identity'); continue; }
    const labeledMs = Math.max(...times);
    const labeledAt = new Date(labeledMs).toISOString().replace('.000Z', 'Z');
    const comments = jsonLines(run(['api', '--paginate', `repos/${o.repo}/issues/${number}/comments?since=${labeledAt}&per_page=100`, '--jq', '.[] | {author: .user.login, at: .created_at} | tojson']));
    if (!comments) { unknown('could not read the comments'); continue; }
    // `since` filters on update time, so the creation time is checked again.
    const reporter = i.author.toLowerCase();
    const answers = comments
      .filter((c) => usable(c.author) && c.author.toLowerCase() === reporter && Date.parse(c.at) > labeledMs)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const ageDays = Math.max(0, Math.floor((nowMs - labeledMs) / DAY_MS));
    if (answers.length) res.answered.push({ number, title, author: i.author, labeledAt, answeredAt: answers[0].at });
    else if (ageDays >= days) res.timedOut.push({ number, title, author: i.author, labeledAt, ageDays });
    else res.waiting.push({ number, title, labeledAt, ageDays });
  }
  emit(res);
  return 0;
}

module.exports = { main, parseArgs, resolveDays, DEFAULT_DAYS };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
