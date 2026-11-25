#!/usr/bin/env node
// trailhead-outward-guard.js: PreToolUse(Bash) hook.
// An outward-facing command (a release, a publish, a tag push, a configured deploy) is
// irreversible. When the session ticket it belongs to has been closed, superseded, paused
// or marked out of scope, the plan still in the model's context is stale: this guard
// BLOCKS such a command and names the ticket and its state.
//   - Matches (default list): `gh release create`, `npm` / `pnpm` / `yarn publish`,
//     `yarn npm publish`, `git push --tags`, `git push` of a tag ref (`refs/tags/..`,
//     `+refs/tags/..`, `src:refs/tags/..`, `tag <name>`). Plain `git push` is not matched.
//     `outward.commands` (project or global `.trailhead/config.json`, nested or flat key)
//     adds command prefixes (`vercel deploy --prod`); `outward.enabled: false` turns the
//     guard off. The project value wins over the global one, key by key.
//   - Commands are read with the shared quote/heredoc-aware lexer (lib/shell-scan.js) and
//     the wrapper table (lib/wrappers.js): `sudo`, `env X=1`, `timeout 60` ... are peeled,
//     text inside quotes or a heredoc is never a command. A `bash -c '<cmd>'` payload is read too.
//   - A construct the guard cannot interpret (lib/unmodelled.js: eval, alias, function ...)
//     that hides a listed command is blocked with a "rewrite it in a simple form" message,
//     but only when a session ticket marker exists (threat model of #226).
//   - Ticket in play: the marker `.trailhead/session-ticket` at the git top of the hook cwd.
//     No marker -> allow silently (the host's permission prompt decides). A marker that
//     cannot be read or has no `#<n>` -> block (fail closed). Otherwise one
//     `gh issue view <n> --json state,stateReason,labels,title`: closed, or labelled
//     `trailhead:superseded` / `trailhead:paused` / `trailhead:out-of-scope` -> block; a
//     failed lookup (gh missing, offline, bad token, unreadable issue) -> block, naming why.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Crash-safe: any internal error -> allow. Self-contained except for the sibling lib/ modules
// and trailhead-test-guard.js (config dir rule). Pure functions are exported for tests and
// the merged trailhead-bash-guards.js; runs as a hook when executed directly.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { basename, splitStatements, tokenize, stripQuotes, stripRedirections, skipEnvPrefix } = require('./lib/shell-scan.js');
const { INSTALL_WRAPPERS, skipWrapperFlags } = require('./lib/wrappers.js');
const { parseGhSubcommand } = require('./lib/gh-subcommand.js');
const { takesSeparateValue } = require('./lib/git-globals.js');
const { configDir, gitTop, readJson } = require('./trailhead-test-guard.js');

const MARKER = path.join('.trailhead', 'session-ticket');
const LOOKUP_TIMEOUT_MS = 8000;
const MAX_DEPTH = 4;
const DEAD_LABELS = ['trailhead:superseded', 'trailhead:out-of-scope', 'trailhead:paused'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// --- matching --------------------------------------------------------------

// The text of an `env -S` payload token (double-quoted: its bash escapes go too).
function payloadText(payload) {
  const p = payload || '';
  const stripped = stripQuotes(p);
  const dq = p.length >= 2 && p.startsWith('"') && p.endsWith('"');
  return dq ? stripped.replace(/\\([$`"\\])/g, '$1') : stripped;
}

// One statement as plain words: NAME=value prefixes, wrappers (with their flags),
// redirections and quotes removed. [] when nothing is left.
function normalise(stmt) {
  let toks = tokenize(stmt);
  let i = 0;
  for (;;) {
    i += skipEnvPrefix(toks.slice(i));
    const wrapper = basename(stripQuotes(toks[i] || ''));
    if (!INSTALL_WRAPPERS.has(wrapper)) break;
    const r = skipWrapperFlags(toks, i, {
      name: wrapper,
      lookup: true,
      norm: stripQuotes,
      tokenize: (payload) => tokenize(payloadText(payload)),
    });
    toks = r.toks;
    i = r.next;
  }
  return stripRedirections(toks.slice(i)).map(stripQuotes);
}

// npm / pnpm / yarn flags whose value is the next token.
const PKG_VALUE_FLAGS = new Set([
  '--prefix', '-C', '--workspace', '-w', '--filter', '-F', '--dir', '--cwd',
  '--registry', '--userconfig', '--globalconfig', '--loglevel',
]);

// First positional of `args` past leading flags (and their separate-token values).
function firstPositional(args, valueFlags) {
  for (let j = 0; j < args.length; j++) {
    const t = args[j];
    if (t === '--') return j + 1 < args.length ? { word: args[j + 1], index: j + 1 } : null;
    if (t.startsWith('-') && t !== '-') {
      if (valueFlags.has(t)) j++;
      continue;
    }
    return { word: t, index: j };
  }
  return null;
}

// Push options that take a separate-token value.
const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);

function isTagPush(args) {
  const positionals = [];
  for (let j = 0; j < args.length; j++) {
    const t = args[j];
    if (t === '--tags') return true;
    if (t.includes('refs/tags/')) return true;
    if (t.startsWith('-') && t !== '-') {
      if (PUSH_VALUE_FLAGS.has(t)) j++;
      continue;
    }
    positionals.push(t);
  }
  // `git push origin tag v1` (git expands it to refs/tags/v1)
  return positionals.length >= 3 && positionals[1] === 'tag';
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

// The default-list name this statement matches, or null.
function defaultMatch(words, depth) {
  if (words.length === 0) return null;
  const bin = basename(words[0]);
  if (bin === 'gh') {
    const p = parseGhSubcommand(words.join(' '));
    return p && p.sub === 'release' && p.verb === 'create' ? 'gh release create' : null;
  }
  if (bin === 'npm' || bin === 'pnpm') {
    const p = firstPositional(words.slice(1), PKG_VALUE_FLAGS);
    return p && p.word === 'publish' ? `${bin} publish` : null;
  }
  if (bin === 'yarn') {
    const p = firstPositional(words.slice(1), PKG_VALUE_FLAGS);
    if (!p) return null;
    if (p.word === 'publish') return 'yarn publish';
    if (p.word === 'npm') {
      const q = firstPositional(words.slice(1 + p.index + 1), PKG_VALUE_FLAGS);
      return q && q.word === 'publish' ? 'yarn npm publish' : null;
    }
    return null;
  }
  if (bin === 'git') {
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) i += takesSeparateValue(words[i]) ? 2 : 1;
    if (words[i] !== 'push') return null;
    return isTagPush(words.slice(i + 1)) ? 'git push (tag)' : null;
  }
  if (SHELLS.has(bin) && depth < MAX_DEPTH) {
    // `bash -c '<cmd>'`: the payload is the command line
    for (let j = 1; j < words.length; j++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[j]) && words[j + 1] !== undefined) {
        const hit = detect(words[j + 1], [], depth + 1);
        return hit ? hit.name : null;
      }
    }
  }
  return null;
}

// Does `words` start with the prefix of a configured command (exact word compare)?
function configMatch(words, extra) {
  for (const entry of extra) {
    const want = tokenize(entry).map(stripQuotes);
    if (want.length === 0 || words.length < want.length) continue;
    if (want.every((w, k) => words[k] === w)) return entry;
  }
  return null;
}

function detect(cmd, extra, depth) {
  for (const stmt of splitStatements(String(cmd))) {
    const words = normalise(stmt);
    const name = defaultMatch(words, depth) || configMatch(words, extra);
    if (name) return { name };
  }
  return null;
}

// The outward command a Bash command line runs: { name } or null.
function detectOutward(cmd, opts) {
  return detect(cmd, (opts && opts.extra) || [], 0);
}

// --- config ----------------------------------------------------------------

function pick(cfg, key) {
  if (!cfg) return { found: false };
  if (isObject(cfg.outward) && has(cfg.outward, key)) return { found: true, value: cfg.outward[key] };
  if (has(cfg, `outward.${key}`)) return { found: true, value: cfg[`outward.${key}`] };
  return { found: false };
}

// { enabled, commands } from the project config over the global one, key by key.
// An invalid value is ignored (the next layer, then the default, applies).
function readOutward(cwd, env) {
  const top = gitTop(cwd);
  const layers = [
    top ? readJson(path.join(top, '.trailhead', 'config.json')) : null,
    readJson(path.join(configDir(env), 'trailhead', 'config.json')),
  ];
  let enabled = true;
  let commands = [];
  for (const cfg of layers) {
    const e = pick(cfg, 'enabled');
    if (e.found && typeof e.value === 'boolean') { enabled = e.value; break; }
  }
  for (const cfg of layers) {
    const c = pick(cfg, 'commands');
    if (c.found && Array.isArray(c.value)) {
      commands = c.value.filter((s) => typeof s === 'string' && s.trim() !== '');
      break;
    }
  }
  return { enabled, commands };
}

// --- ticket in play --------------------------------------------------------

// The marker's ticket: { n, title }, or { malformed: true }.
function readMarker(file, readFile) {
  try {
    const first = String(readFile(file)).split(/\r?\n/, 1)[0].trim();
    const m = /^#(\d+)\b\s*(.*)$/.exec(first);
    return m ? { n: Number(m[1]), title: m[2].trim() } : { malformed: true };
  } catch {
    return { malformed: true };
  }
}

// The default lookup: one `gh issue view`. { data } or { error }.
function ghLookup(n, cwd) {
  const r = spawnSync('gh', ['issue', 'view', String(n), '--json', 'state,stateReason,labels,title'], {
    cwd, timeout: LOOKUP_TIMEOUT_MS, encoding: 'utf8',
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') return { error: 'gh not found' };
    if (r.error.code === 'ETIMEDOUT') return { error: 'timed out' };
    return { error: String(r.error.message || r.error).split('\n')[0] };
  }
  if (r.status !== 0) {
    const line = String(r.stderr || '').split('\n').find((l) => l.trim());
    return { error: line ? line.trim() : `gh exited with ${r.status}` };
  }
  try {
    const data = JSON.parse(r.stdout);
    if (!isObject(data) || typeof data.state !== 'string') return { error: 'gh returned no issue state' };
    return { data };
  } catch {
    return { error: 'gh returned unparsable output' };
  }
}

const block = (code, reason) => ({ kind: 'block', payload: { decision: 'block', code, reason } });
const ticketName = (title, n) => (title ? `${title} (#${n})` : `#${n}`);

// Null (the ticket is live) or a block verdict. `lookup(n)` -> { data } | { error }.
function ticketVerdict(marker, lookup, what) {
  const held = what ? `\`${what}\` is outward-facing` : 'this command is outward-facing';
  if (!marker || marker.malformed) {
    return block(
      'OUTWARD_MARKER_UNREADABLE',
      `trailhead outward-guard: ${held}, but .trailhead/session-ticket is malformed (unreadable, empty, or ` +
        'its first line has no `#<n>`), so the ticket in play cannot be checked. Fix the marker, or remove it if no ticket is in play.',
    );
  }
  let res;
  try {
    res = lookup(marker.n);
  } catch (e) {
    res = { error: String((e && e.message) || e).split('\n')[0] };
  }
  if (!res || res.error || !res.data || typeof res.data.state !== 'string') {
    const why = (res && res.error) || 'no issue state returned';
    return block(
      'OUTWARD_TICKET_LOOKUP_FAILED',
      `trailhead outward-guard: ${held}, and the state of the session ticket ${ticketName(marker.title, marker.n)} ` +
        `could not be checked (${why}). Fix gh (auth, network), or remove .trailhead/session-ticket if that ticket is no longer in play.`,
    );
  }
  const { state, stateReason } = res.data;
  const labels = (Array.isArray(res.data.labels) ? res.data.labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
  let dead = null;
  if (labels.includes('trailhead:superseded')) dead = 'superseded';
  else if (labels.includes('trailhead:out-of-scope')) dead = 'out of scope';
  else if (String(state).toUpperCase() === 'CLOSED') dead = stateReason ? `closed (${String(stateReason).toLowerCase()})` : 'closed';
  else if (labels.includes('trailhead:paused')) dead = 'paused';
  if (!dead) return null;
  const title = res.data.title || marker.title;
  return block(
    'OUTWARD_TICKET_DEAD',
    `trailhead outward-guard: ${held}, and the session ticket ${ticketName(title, marker.n)} is ${dead}: ` +
      'the ticket in play is no longer live, so the command is held. To proceed on purpose, remove ' +
      '.trailhead/session-ticket (or work a live ticket).',
  );
}

// --- verdict ---------------------------------------------------------------

function unmodelledHit(cmd, extra) {
  const { findUnmodelled, firstRelevant } = require('./lib/unmodelled.js');
  return firstRelevant(findUnmodelled(cmd), (text) => detect(text, extra, 0) !== null);
}

// Pure verdict: null (allow), or { kind:'block', payload }. Never exits or writes; any
// internal error allows. opts: { env, cwd, lookup, exists, readFile }.
function evaluate(cmd, opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const cfg = readOutward(o.cwd, env);
    if (!cfg.enabled) return null;
    const hit = detectOutward(cmd, { extra: cfg.commands });
    const gap = hit ? null : unmodelledHit(cmd, cfg.commands);
    if (!hit && !gap) return null; // not outward-facing: nothing to look up
    const base = gitTop(o.cwd) || path.resolve(o.cwd || process.cwd());
    const file = path.join(base, MARKER);
    if (!(o.exists || fs.existsSync)(file)) return null; // no ticket in play: the host's prompt decides
    if (gap) {
      const { unmodelledReason } = require('./lib/unmodelled.js');
      return block(
        'OUTWARD_UNMODELLED_CONSTRUCT',
        unmodelledReason('outward-guard', 'that it is not an outward-facing command held by a dead ticket', gap),
      );
    }
    const marker = readMarker(file, o.readFile || ((f) => fs.readFileSync(f, 'utf8')));
    const lookup = o.lookup || ((n) => ghLookup(n, base));
    return ticketVerdict(marker, lookup, hit.name);
  } catch {
    return null; // a guard must never wedge the workflow
  }
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
  const v = evaluate(cmd, { cwd, env: process.env });
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

module.exports = { detectOutward, readOutward, readMarker, ticketVerdict, evaluate, DEAD_LABELS };
