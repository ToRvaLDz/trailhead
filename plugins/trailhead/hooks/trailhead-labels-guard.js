#!/usr/bin/env node
// trailhead-labels-guard.js: PreToolUse(Bash) hook.
// A trailhead ticket is identified by its label set: `trailhead:ticket`, exactly one
// type label and exactly one destination (a map or the whiteboard). When an agent
// opens a ticket with `gh issue create` and forgets part of that set (or adds the
// missing labels in a later call that never comes), the ticket is invisible to the
// board and the engine. This guard checks the label set at the create call itself.
//   - A create that carries at least one `trailhead:*` label must carry the whole
//     ticket shape: `trailhead:ticket`, exactly one of trailhead:decision | research |
//     prototype | build | bug | task, and exactly one of `trailhead:map-<n>` |
//     `trailhead:whiteboard` (never both, never two maps). Non-ticket trailhead issues
//     (`trailhead:map`, `trailhead:dashboard`, `trailhead:codebase`,
//     `trailhead:conventions`, and `trailhead:fog` / `trailhead:unverified`) are exempt.
//     State labels (blocked, seed, paused, ...) are allowed extras and never count
//     toward the shape. This rule applies in any repo.
//   - A create with NO `trailhead:*` label is blocked too, but only inside a trailhead
//     repo (the hook cwd sits in a git work tree whose top level has a `.trailhead/`
//     directory) and not when aimed at another repo (-R / --repo / GH_REPO=). A
//     deliberate non-trailhead issue opts out by prefixing the command with
//     `TRAILHEAD_PLAIN_ISSUE=1`, like the install guard's TRAILHEAD_VERIFIED_INSTALL=1.
//     After a `cd` the working directory is unknown, so this ground never blocks there.
//   - A label value that cannot be resolved statically ($VAR, `$(...)`, backticks) makes
//     the whole create unparseable: it is never blocked on what cannot be read.
// The command is not required to START with `gh`: the shared statement walk (ghWrites in
// secret-guard) finds each `gh issue create` through `;` `&&` `||` `|`, subshells and
// leading NAME=v. Opaque writes (eval, sh -c, ...) are ignored (fail-open).
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Crash-safe: any error -> allow. Self-contained except for the sibling lib/ modules and
// the secret-guard statement walk. Pure functions are exported for tests and the merged
// trailhead-bash-guards.js; runs as a hook when executed directly.

const fs = require('fs');
const path = require('path');
const { parseGhSubcommand, dequote } = require('./lib/gh-subcommand.js');
const { words, parseRedirects } = require('./lib/body-sources.js');

const PLAIN_SENTINEL = /(?:^|\s)TRAILHEAD_PLAIN_ISSUE=1(?:\s|$)/;
const TYPES = ['decision', 'research', 'prototype', 'build', 'bug', 'task'];
const EXEMPT = ['trailhead:map', 'trailhead:dashboard', 'trailhead:codebase', 'trailhead:conventions', 'trailhead:fog', 'trailhead:unverified'];
const MAP_RE = /^trailhead:map-\d+$/;
const WHITEBOARD = 'trailhead:whiteboard';
const TYPE_LIST = TYPES.map((t) => `trailhead:${t}`).join(' | ');

// gh issue create flags that consume a value (long and short forms).
const VALUE_FLAGS = new Set([
  '--assignee', '--body', '--body-file', '--label', '--milestone', '--project', '--repo', '--title', '--template', '--recover',
  '-a', '-b', '-F', '-l', '-m', '-p', '-R', '-t', '-T',
]);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Read the options of one `gh issue create` statement.
//   { labels: [lowercased label names], unresolved: bool, repoFlag: bool }
function parseCreate(text) {
  const { args } = parseRedirects(words(text));
  const toks = args.map(dequote);
  const labels = [];
  let unresolved = false;
  let repoFlag = false;
  let afterCreate = false;
  let sawIssue = false;
  const take = (v) => {
    if (/[$`]/.test(v)) unresolved = true;
    for (const part of v.split(',')) {
      const l = part.trim().toLowerCase();
      if (l) labels.push(l);
    }
  };
  // leading NAME=v: GH_REPO aims the command at another repo
  let i = 0;
  while (i < toks.length && ASSIGN_RE.test(toks[i])) {
    if (/^GH_REPO=/.test(toks[i])) repoFlag = true;
    i++;
  }
  for (i += 1; i < toks.length; i++) { // past the gh word
    const t = toks[i];
    if (!t.startsWith('-')) {
      if (!sawIssue && t === 'issue') sawIssue = true;
      else if (sawIssue && t === 'create') afterCreate = true;
      continue;
    }
    let flag = t;
    let value;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq !== -1) { flag = t.slice(0, eq); value = t.slice(eq + 1); }
      else if (VALUE_FLAGS.has(t)) value = toks[++i];
    } else if (VALUE_FLAGS.has(t)) {
      value = toks[++i];
    } else if (t.length > 2 && VALUE_FLAGS.has(t.slice(0, 2))) {
      flag = t.slice(0, 2); // glued shorthand: -lbug, -l=bug
      value = t.slice(2).replace(/^=/, '');
    }
    if (value === undefined) continue;
    if (flag === '-R' || flag === '--repo') repoFlag = true;
    else if (afterCreate && (flag === '--label' || flag === '-l')) take(value);
  }
  return { labels, unresolved, repoFlag };
}

// Is `cwd` in a git work tree whose top level has a `.trailhead/` directory? Walks up to
// the first directory holding `.git` (dir or file). Any fs error -> false (fail open).
function inTrailheadRepo(cwd) {
  try {
    let dir = path.resolve(cwd || process.cwd());
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return fs.statSync(path.join(dir, '.trailhead')).isDirectory();
      }
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  } catch {
    return false;
  }
}

// The ticket-shape problems of a label set that has at least one trailhead:* label
// and is not a non-ticket issue. Empty list = well formed.
function shapeProblems(th) {
  const problems = [];
  if (!th.includes('trailhead:ticket')) problems.push('missing `trailhead:ticket`');
  const types = th.filter((l) => TYPES.some((t) => l === `trailhead:${t}`));
  if (types.length === 0) problems.push(`missing a type label (exactly one of ${TYPE_LIST})`);
  else if (new Set(types).size > 1) problems.push(`conflicting type labels (${[...new Set(types)].join(', ')}): keep exactly one`);
  const maps = [...new Set(th.filter((l) => MAP_RE.test(l)))];
  const board = th.includes(WHITEBOARD);
  if (maps.length === 0 && !board) problems.push('missing a destination (exactly one of `trailhead:map-<n>` | `trailhead:whiteboard`)');
  else if (maps.length > 1) problems.push(`two map destinations (${maps.join(', ')}): keep exactly one`);
  else if (maps.length === 1 && board) problems.push(`two destinations (${maps[0]} and ${WHITEBOARD}): keep exactly one`);
  return problems;
}

const RETRY =
  'Retry with the full label set in the SAME `gh issue create` call (`--label trailhead:ticket --label <type> --label <destination>`); ' +
  'never add labels afterwards with `--add-label`.';

function block(code, reason) {
  return { kind: 'block', payload: { decision: 'block', code, reason } };
}

// Verdict for one parsed create, or null to allow.
function checkCreate(parsed, { cmd, cwd, cwdKnown }) {
  if (parsed.unresolved) return null; // a label we cannot read: never block on it
  const th = parsed.labels.filter((l) => l.startsWith('trailhead:'));
  if (th.length > 0) {
    if (th.some((l) => EXEMPT.includes(l))) return null; // a non-ticket trailhead issue
    const problems = shapeProblems(th);
    if (problems.length === 0) return null;
    return block(
      'TICKET_LABELS_INCOMPLETE',
      `trailhead: this gh issue create opens a trailhead ticket (labels: ${th.join(', ')}) with an incomplete label set: ${problems.join('; ')}. ${RETRY}`,
    );
  }
  if (parsed.repoFlag || !cwdKnown || PLAIN_SENTINEL.test(cmd)) return null;
  if (!inTrailheadRepo(cwd)) return null;
  return block(
    'TRAILHEAD_ISSUE_WITHOUT_LABELS',
    'trailhead: this gh issue create carries no `trailhead:*` label, so the issue would be invisible to the board and the engine. ' +
      `${RETRY} ` +
      'For a deliberate non-trailhead issue, re-run the exact command prefixed with `TRAILHEAD_PLAIN_ISSUE=1`.',
  );
}

// Every statement of the command that is a `gh issue create`: { text, cwdKnown }.
function creates(cmd) {
  let ghWrites;
  try {
    ({ ghWrites } = require('./trailhead-secret-guard.js'));
  } catch {
    return [{ text: cmd, cwdKnown: true }]; // partial install: check the lone statement
  }
  const out = [];
  for (const w of ghWrites(cmd, {})) {
    if (w.kind !== 'issue') continue;
    const p = parseGhSubcommand(w.text);
    if (p && p.sub === 'issue' && p.verb === 'create') out.push({ text: w.text, cwdKnown: w.cwdKnown });
  }
  return out;
}

// Pure verdict: null (allow), or { kind:'block', payload }. Never exits or writes; any
// internal error allows.
function evaluate(cmd, opts) {
  try {
    const cwd = opts && opts.cwd;
    for (const c of creates(String(cmd))) {
      const p = parseGhSubcommand(c.text);
      if (!p || p.sub !== 'issue' || p.verb !== 'create') continue;
      const verdict = checkCreate(parseCreate(c.text), { cmd: String(cmd), cwd, cwdKnown: c.cwdKnown });
      if (verdict) return verdict;
    }
  } catch {
    // a guard must never wedge the workflow
  }
  return null;
}

function run(data) {
  let cmd = '';
  let cwd;
  try {
    const input = JSON.parse(data);
    cmd = (input.tool_input || {}).command || '';
    cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined;
  } catch {
    process.exit(0);
  }
  const v = evaluate(cmd, { cwd });
  if (v && v.kind === 'block') {
    process.stdout.write(JSON.stringify(v.payload));
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends -> give up
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { parseCreate, shapeProblems, inTrailheadRepo, evaluate };
