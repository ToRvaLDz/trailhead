#!/usr/bin/env node
// trailhead-test-guard.js: PreToolUse(Bash) hook.
// Several agent sessions share one machine, and each of them running the whole test
// suite at once starves it. `testing.full` (project `.trailhead/config.json`, or the
// global `<config dir>/trailhead/config.json`) names the full-suite command; the queue
// helper `trailhead-test-run.js` serialises those runs. This guard blocks a Bash call
// that runs the bare `testing.full` command outside the helper.
//   - Off unless `testing.full` is a non-empty string (nested `{"testing":{"full":..}}`
//     or flat `"testing.full"`, nested wins; the project value replaces the global one,
//     the same rule as the helper). Unset, unreadable or invalid config -> allow.
//   - `testing.full` and the command are both split into statements; each statement
//     drops NAME=v prefixes, redirections and the wrappers an agent writes by mistake
//     (`env`, `time`, `command`, `nice`, `timeout`). The command is blocked when it
//     holds the statements of `testing.full` consecutively, every statement word-equal
//     except the last, which may add only flag arguments (a token starting with `-`).
//     A non-flag extra argument is a focused run (`npm test -- hooks/x.test.js`) and passes.
//   - Compound matching compares statements, not the operators between them. A `cd` /
//     `pushd` statement before the match means the working directory is unknown: allow.
//   - The helper's own invocation (`node .../trailhead-test-run.js ...`) never matches.
//   - Opaque forms (`bash -c`, `eval`) are not unwrapped: guards target accidental mistakes.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Crash-safe: any error -> allow. Self-contained except for lib/shell-scan.js. Pure
// functions are exported for tests and the merged trailhead-bash-guards.js; runs as a
// hook when executed directly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitStatements, tokenize, stripQuotes, stripRedirections, skipEnvPrefix } = require('./lib/shell-scan.js');

const HELPER = 'trailhead-test-run.js';
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
// timeout options that consume a value as the next token (when not glued).
const TIMEOUT_VALUE_OPTS = new Set(['-s', '--signal', '-k', '--kill-after']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// --- config ----------------------------------------------------------------

function readJson(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(cfg) ? cfg : null;
  } catch {
    return null;
  }
}

// The testing.full entry of one parsed config: { found, value }. Nested wins over flat.
function pickFull(cfg) {
  if (!cfg) return { found: false };
  if (isObject(cfg.testing) && has(cfg.testing, 'full')) return { found: true, value: cfg.testing.full };
  if (has(cfg, 'testing.full')) return { found: true, value: cfg['testing.full'] };
  return { found: false };
}

// The git top level above `cwd` (first dir holding `.git`, dir or file), or null.
function gitTop(cwd) {
  try {
    let dir = path.resolve(cwd || process.cwd());
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
    return null;
  }
}

// Su Codex lo script vive in <codexHome>/skills/trailhead/<dir>: la config globale sta lì, non in ~/.claude.
const CODEX_INSTALL = /[\\/]skills[\\/]trailhead[\\/](?:hooks|templates)$/;
const codexHome = () => (CODEX_INSTALL.test(__dirname) ? path.resolve(__dirname, '..', '..', '..') : null);

function configDir(env) {
  return codexHome() || (env && env.CLAUDE_CONFIG_DIR) || path.join((env && env.HOME) || os.homedir(), '.claude');
}

// The effective testing.full string, or null when the guard is off. The project value
// replaces the global one even when it is invalid (then the guard is off).
function readFull(cwd, env) {
  const top = gitTop(cwd);
  const layers = [
    top ? readJson(path.join(top, '.trailhead', 'config.json')) : null,
    readJson(path.join(configDir(env), 'trailhead', 'config.json')),
  ];
  for (const cfg of layers) {
    const p = pickFull(cfg);
    if (!p.found) continue;
    return typeof p.value === 'string' && p.value.trim() !== '' ? p.value : null;
  }
  return null;
}

// --- statement normalisation -----------------------------------------------

// One statement as a word list without env prefixes, redirections and wrappers, or [].
function normalise(stmt) {
  let toks = stripRedirections(tokenize(stmt)).map(stripQuotes);
  for (let guard = 0; guard < 20; guard++) {
    toks = toks.slice(skipEnvPrefix(toks));
    if (toks.length === 0) return [];
    const head = toks[0];
    if (head === 'env') {
      let i = 1;
      while (i < toks.length) {
        if (ASSIGN_RE.test(toks[i])) i++;
        else if (toks[i] === '-u' || toks[i] === '-C') i += 2;
        else if (toks[i].startsWith('-') && toks[i] !== '-') i++;
        else break;
      }
      toks = toks.slice(i);
    } else if (head === 'time') {
      let i = 1;
      while (i < toks.length && toks[i].startsWith('-')) i++;
      toks = toks.slice(i);
    } else if (head === 'command') {
      let i = 1;
      while (i < toks.length && toks[i].startsWith('-') && toks[i] !== '--') i++;
      if (toks[i] === '--') i++;
      toks = toks.slice(i);
    } else if (head === 'nice') {
      let i = 1;
      if (toks[i] === '-n') i += 2;
      else if (/^-n\d+$/.test(toks[i] || '') || /^-\d+$/.test(toks[i] || '')) i++;
      toks = toks.slice(i);
    } else if (head === 'timeout') {
      let i = 1;
      while (i < toks.length && toks[i].startsWith('-')) {
        i += TIMEOUT_VALUE_OPTS.has(toks[i]) ? 2 : 1;
      }
      if (i < toks.length && DURATION_RE.test(toks[i])) i++;
      toks = toks.slice(i);
    } else {
      return toks;
    }
  }
  return toks;
}

const statementsOf = (text) => splitStatements(String(text)).map(normalise);

const isCd = (words) => words[0] === 'cd' || words[0] === 'pushd';
const isHelper = (words) => words.some((w) => path.basename(w) === HELPER);

// Does `words` run the `want` statement; the last one may add only flag arguments?
function matchesStatement(words, want, last) {
  if (words.length < want.length) return false;
  for (let i = 0; i < want.length; i++) if (words[i] !== want[i]) return false;
  const extra = words.slice(want.length);
  if (!last) return extra.length === 0;
  return extra.every((w) => w.startsWith('-'));
}

// Does the command run the `full` statements, with a known working directory?
function runsFull(cmdStmts, fullStmts) {
  for (let start = 0; start + fullStmts.length <= cmdStmts.length; start++) {
    if (cmdStmts.slice(0, start).some(isCd)) return false; // unknown cwd from here on
    const hit = fullStmts.every((want, k) => {
      const words = cmdStmts[start + k];
      return !isHelper(words) && matchesStatement(words, want, k === fullStmts.length - 1);
    });
    if (hit) return true;
  }
  return false;
}

// --- reason ----------------------------------------------------------------

function helperPath(env) {
  const candidates = [path.join(__dirname, '..', 'templates'), path.join(configDir(env), 'trailhead', 'templates')];
  const dir = candidates.find((d) => fs.existsSync(path.join(d, HELPER)));
  return dir ? path.join(dir, HELPER) : HELPER;
}

function block(full, env, root) {
  const reason =
    `trailhead: this Bash call runs the full test suite (\`${full}\`) directly. Several sessions doing that at once starve the machine. ` +
    'Run focused tests instead (pass only the test files you touched, or the `testing.targeted` command when it is set), ' +
    `or queue the full run with the helper: \`node ${helperPath(env)} run --repo ${root || '<repo root>'}\`.`;
  return { kind: 'block', payload: { decision: 'block', code: 'UNQUEUED_FULL_TEST_RUN', reason } };
}

// Pure verdict: null (allow), or { kind:'block', payload }. Never exits or writes; any
// internal error allows.
function evaluate(cmd, opts) {
  try {
    const cwd = opts && opts.cwd;
    const env = (opts && opts.env) || process.env;
    const full = readFull(cwd, env);
    if (!full) return null;
    const fullStmts = statementsOf(full);
    if (fullStmts.length === 0 || fullStmts.some((s) => s.length === 0)) return null;
    if (!runsFull(statementsOf(cmd), fullStmts)) return null;
    return block(full, env, gitTop(cwd));
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

module.exports = { configDir, evaluate, readFull, normalise, runsFull };
