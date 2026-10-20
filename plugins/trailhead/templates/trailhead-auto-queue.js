#!/usr/bin/env node
'use strict';
// trailhead auto queue (self-contained, ships in templates/ so it reaches every
// install channel). Builds the ordered work queue of an autonomous run for a chosen
// run scope: one map, the whiteboard, or everything. #280.
//
// CLI:
//   node trailhead-auto-queue.js scopes [--repo <owner/name>]
//   node trailhead-auto-queue.js queue --scope map:<n>|whiteboard|everything
//        [--skip <csv>] [--repo <owner/name>]
//
// The frontier is the canonical frontier query (substrate-commands.md): open,
// `trailhead:ticket`, unassigned, not blocked / unverified / paused. The
// `trailhead:blocked` label is the source of truth for blockers; this helper adds
// no dependency logic. Groups are ordered by map number ascending, the whiteboard
// last; tickets inside a group ascending by number. `--skip` names the tickets the
// run already set aside or stopped on; `next` is the lowest ticket of the first
// group that still has one (null when the scope is drained). A read that hits the
// 1000 limit fails closed (never a partial queue).
//
// Prints exactly one JSON line on stdout:
//   scopes: {"status":"ok","maps":[{"number","title","frontier"}],"whiteboard":{"frontier"}}
//   queue:  {"status":"ok","scope","groups":[{"kind","map","title","tickets":[{"number","title","type"}],"resume":[...]}],"drift":[...],"next":{...}|null}
//   error:  {"status":"error","reason":"..."}
// Exit 0 on ok, 1 on an error, 2 on a usage error (stderr).

const { spawnSync } = require('child_process');

const LIMIT = 1000;
const FRONTIER_SEARCH = 'no:assignee -label:trailhead:blocked -label:trailhead:unverified -label:trailhead:paused';
const WHITEBOARD = 'trailhead:whiteboard';
const MAP_LABEL_RE = /^trailhead:map-(\d+)$/;
const TYPES = ['decision', 'research', 'prototype', 'build', 'bug', 'task'];

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const names = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const byNumber = (a, b) => a.number - b.number;

function parseScope(v) {
  if (v === 'everything' || v === 'whiteboard') return v;
  return /^map:[1-9]\d*$/.test(String(v)) ? v : null;
}

function parseArgs(argv) {
  const cmd = argv[0];
  if (cmd !== 'scopes' && cmd !== 'queue') return { error: `usage: expected scopes or queue, got: ${cmd === undefined ? '(nothing)' : cmd}` };
  const o = { cmd, repo: null, scope: null, skip: [] };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const allowed = cmd === 'queue' ? ['--repo', '--scope', '--skip'] : ['--repo'];
    if (!allowed.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const v = argv[i];
    if (flag === '--repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: `usage: --repo must be owner/name, got: ${v}` };
      o.repo = v;
    } else if (flag === '--scope') {
      o.scope = parseScope(v);
      if (!o.scope) return { error: `usage: --scope must be map:<n>, whiteboard or everything, got: ${v}` };
    } else {
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.every((s) => /^[1-9]\d*$/.test(s))) return { error: `usage: --skip must be a csv of ticket numbers, got: ${v}` };
      o.skip = parts.map(Number);
    }
  }
  if (cmd === 'queue' && !o.scope) return { error: 'usage: queue requires --scope' };
  return o;
}

const typeOf = (labelNames) => {
  const t = TYPES.find((x) => labelNames.includes(`trailhead:${x}`));
  return t || null;
};

// Places each ticket: on its open map, else the whiteboard, else nowhere. A ticket
// on more than one open map is drift (placed on none).
function place(openMaps, issues) {
  const open = new Set(openMaps.map((m) => m.number));
  const byMap = new Map(openMaps.map((m) => [m.number, []]));
  const whiteboard = [];
  const drift = [];
  for (const i of issues) {
    const ln = names(i.labels);
    const mapNums = ln.map((l) => (MAP_LABEL_RE.exec(l) || [])[1]).filter(Boolean).map(Number).filter((n) => open.has(n));
    const row = { number: i.number, title: i.title, type: typeOf(ln) };
    if (mapNums.length > 1) drift.push({ ...row, maps: [...new Set(mapNums)].sort((a, b) => a - b), whiteboard: ln.includes(WHITEBOARD) });
    else if (mapNums.length === 1) byMap.get(mapNums[0]).push(row);
    else if (ln.includes(WHITEBOARD)) whiteboard.push(row);
  }
  return { byMap, whiteboard, drift };
}

// Pure: openMaps [{number,title}], frontier / paused issues [{number,title,labels}],
// scope, skip [n]. Returns { groups, drift, next } or { error }.
function buildQueue(openMaps, frontier, paused, scope, skip) {
  const skipSet = new Set(skip || []);
  const live = (list) => list.filter((i) => !skipSet.has(i.number));
  const maps = [...openMaps].sort(byNumber);
  let wantMaps = maps;
  let wantWhiteboard = scope === 'whiteboard' || scope === 'everything';
  if (scope === 'whiteboard') wantMaps = [];
  else if (scope.startsWith('map:')) {
    const n = Number(scope.slice(4));
    wantMaps = maps.filter((m) => m.number === n);
    if (!wantMaps.length) return { error: `map #${n} is not an open trailhead:map` };
    wantWhiteboard = false;
  }
  const f = place(maps, live(frontier));
  const p = place(maps, live(paused));
  const sorted = (rows) => [...rows].sort(byNumber);
  const groups = wantMaps.map((m) => ({ kind: 'map', map: m.number, title: m.title, tickets: sorted(f.byMap.get(m.number)), resume: sorted(p.byMap.get(m.number)) }));
  if (wantWhiteboard) groups.push({ kind: 'whiteboard', map: null, title: 'Whiteboard', tickets: sorted(f.whiteboard), resume: sorted(p.whiteboard) });
  const inScope = (d) => (scope === 'everything'
    || (scope === 'whiteboard' && d.whiteboard)
    || (scope.startsWith('map:') && d.maps.includes(Number(scope.slice(4)))));
  const seen = new Set();
  const drift = [...f.drift, ...p.drift].filter(inScope).filter((d) => !seen.has(d.number) && seen.add(d.number)).sort(byNumber)
    .map(({ number, title, type, maps: ms }) => ({ number, title, type, maps: ms }));
  const first = groups.find((g) => g.tickets.length);
  const next = first ? { ...first.tickets[0], map: first.map } : null;
  return { groups, drift, next };
}

function readList(run, args, what) {
  const r = run(args);
  if (r.status !== 0) return { error: `gh issue list (${what}) failed: ${firstLine(r.stderr) || 'exit ' + r.status}` };
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return { error: `gh issue list (${what}) returned unparseable JSON` }; }
  if (!Array.isArray(rows)) return { error: `gh issue list (${what}) returned unexpected JSON` };
  if (rows.length >= LIMIT) return { error: `incomplete list: the ${what} read hit the ${LIMIT} limit` };
  return { rows };
}

function main(argv, { gh, stdout, stderr } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const o = parseArgs(argv || []);
  if (o.error) { err.write(o.error + '\n'); return 2; }
  const run = gh || defaultGh;
  const emit = (obj) => out.write(JSON.stringify(obj) + '\n');
  const fail = (reason) => { emit({ status: 'error', reason }); return 1; };
  const R = o.repo ? ['-R', o.repo] : [];
  const lim = ['--limit', String(LIMIT)];

  const maps = readList(run, ['issue', 'list', '--label', 'trailhead:map', '--state', 'open', ...lim, '--json', 'number,title', ...R], 'open maps');
  if (maps.error) return fail(maps.error);
  const frontier = readList(run, ['issue', 'list', '--label', 'trailhead:ticket', '--state', 'open', '--search', FRONTIER_SEARCH, ...lim, '--json', 'number,title,labels', ...R], 'frontier');
  if (frontier.error) return fail(frontier.error);

  if (o.cmd === 'scopes') {
    const q = buildQueue(maps.rows, frontier.rows, [], 'everything', []);
    const wb = q.groups.find((g) => g.kind === 'whiteboard');
    emit({
      status: 'ok',
      maps: q.groups.filter((g) => g.kind === 'map').map((g) => ({ number: g.map, title: g.title, frontier: g.tickets.length })),
      whiteboard: { frontier: wb.tickets.length },
    });
    return 0;
  }

  const paused = readList(run, ['issue', 'list', '--label', 'trailhead:ticket', '--label', 'trailhead:paused', '--assignee', '@me', '--state', 'open', ...lim, '--json', 'number,title,labels', ...R], 'paused claims');
  if (paused.error) return fail(paused.error);
  const q = buildQueue(maps.rows, frontier.rows, paused.rows, o.scope, o.skip);
  if (q.error) return fail(q.error);
  emit({ status: 'ok', scope: o.scope, groups: q.groups, drift: q.drift, next: q.next });
  return 0;
}

module.exports = { main, parseArgs, buildQueue, FRONTIER_SEARCH };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), {}));
}
