#!/usr/bin/env node
'use strict';
// trailhead plan review rounds (self-contained, ships in templates/ so it reaches every
// install channel: bin/trailhead.js copies templates/ wholesale for Claude/npm and Codex).
// Backs the autonomous run's "External review rounds" start-up ask and the per-round
// convergence decision of Cross-AI plan review. #284.
//
// CLI:
//   node trailhead-plan-review-rounds.js ask   --repo <project-root> [--host claude|codex]
//   node trailhead-plan-review-rounds.js round --choice <config|1|2|3|until> --configured <n> --history <file>
//   node trailhead-plan-review-rounds.js budget --repo <project-root> --reviewer <name> --prompt <file>
//   node trailhead-plan-review-rounds.js overflow --output <file> [--prompt <brief file>]
//   node trailhead-plan-review-rounds.js run --output <file> [--timeout <seconds>] -- <cmd> [args...]
// Prints one JSON line on stdout. Exit 0 ok / 1 error / 2 usage (message on stderr).
//
// Config: `plan_review` (off | on | comma list of CLIs, default off) and `plan_review.rounds`
// (positive integer, default 2), flat keys. The project file (<project-root>/.trailhead/config.json)
// and the global one (${CLAUDE_CONFIG_DIR:-~/.claude}/trailhead/config.json) are read key by key,
// nearest wins. A non-positive or non-integer rounds value falls back to 2 with a warning.
//
// ask: resolves the candidate CLIs (`on` = the known roster, a list = only those), keeps the ones
// whose binary is on PATH (kimi only when `kimi --help` mentions --output-format) and drops the
// host's own CLI (claude by default, codex with --host codex). A name in an explicit list that is
// not in the roster (a custom reviewer) counts only when a binary of that name is on PATH; else it
// is listed under `unknown` with a warning and does not count.
//   {"status":"skip","reason":"off"|"no-reviewer","configured":n,"unknown":[],"warnings":[]}
//   {"status":"ask","configured":n,"reviewers":[],"unknown":[],"warnings":[],"options":[],"fallback":[]}
//   {"status":"error","reason":<text>}                (unreadable or invalid config; exit 1)
// `options` is the AskUserQuestion menu, at most four entries (the tool's cap); each entry is
// {"value":"config"|"1"|"2"|"3"|"until","label":<text>,"recommended"?:true}. With n in 1..3 it is
// config (Recommended), the other two counts, until; otherwise config, 1, 2, until (3 stays
// reachable through the typed Other answer). `fallback` is the numbered list for a host without a
// structured question tool: config, 1, 2, 3, until (same entry shape, all five).
//
// round: --history is a JSON array, one entry per review round done so far, each an array of the
// blocking concerns still open after that round; a concern is {"key","text"}: `key` a short stable
// id reused across rounds (compared trimmed, lower-cased, whitespace collapsed), `text` the full
// human-readable concern. A malformed history is a usage error (exit 2).
//   {"status":"ok","decision":<d>,"rounds":<rounds done>,"surviving"?:[{key,text}]}
//   decision, first match wins: converged (latest round has no blocking concern) | no-progress
//   (choice until, round 2 or later: the latest round resolved none of the previous round's
//   concerns) | ceiling (choice until: 5 rounds done) | exhausted (fixed choice: its rounds are
//   spent) | continue. Every stop but converged carries `surviving`, the latest round's concerns.
//   `config` resolves to --configured.
//
// budget: pre-check of one reviewer call. Estimates the prompt file's tokens as ceil(utf8 bytes / 3)
// (an estimate on the high side for code and English, not a guarantee; `overflow` covers what it
// misses) and compares them with cap = floor(window * 0.65), the other 35% being headroom for the
// reviewer's own system prompt and output. The window is the per-CLI default (CONTEXT_WINDOWS, 128000
// for any other name) or the `plan_review.context` override. Decision, first match wins: skip
// (tokens > cap) | file (bytes > 102400, a single Linux argument over 128 KiB fails with E2BIG) | arg.
//   {"status":"ok","reviewer","decision","bytes","tokens","window","cap","windowSource":"default"|"config",
//    "reason"?,"pointer"?,"warnings":[]}
// `reason` (skip) is ready to quote in PLAN-REVIEW; `pointer` (file) is the short argument to pass
// instead of the prompt. Skip is still exit 0: the verdict is data, not a failure.
//
// overflow: post-check of one failed reviewer call. A pure pattern match over the captured output
// (stdout and stderr together) for the known context-overflow and E2BIG messages. With --prompt
// <brief file>, lines of the brief echoed back by the CLI are ignored; rate-limit lines never count.
//   {"status":"ok","overflow":bool,"reason"?:<the matched line, trimmed and length-capped>}
//
// run: launches ONE reviewer call under a wall-clock deadline, so no call can outlive its bound
// (the Bash tool's own `timeout` does not apply to a background call). `--` ends the helper's flags:
// everything after it is the command's argv verbatim (no shell). The command gets stdin closed and its
// stdout and stderr together go to --output (a file descriptor, truncated at start, no pipes), in its
// own process group. At the deadline the group gets SIGTERM, then SIGKILL after a grace period (10s;
// TRAILHEAD_REVIEW_GRACE_MS overrides it, for tests), so a child that ignores SIGTERM and its
// descendants still end. If the helper itself gets SIGTERM, SIGINT or SIGHUP it kills the group first (exit 143, 130, 129).
// A process that leaves the group with setsid is out of reach of the group kill, and a reviewer that
// exits in the window after the deadline fires is still reported `timeout`.
//   {"status":"ok"|"failed"|"timeout"|"error","exitCode":<n|null>,"signal":<s|null>,"seconds":<n>,
//    "timeoutSeconds":<n>,"output":<file>,"reason"?:<text, for failed, timeout and error>}
// ok = exit 0; failed = non-zero exit (or a signal) before the deadline; timeout = the deadline hit,
// whatever the exit then was and even when the output has content (do not run `overflow` on it);
// error = the command could not be launched (ENOENT, E2BIG, EACCES...), the error text is also written
// into --output. All four exit 0 (the reviewer's result is data). --timeout is a positive integer,
// default 600 seconds. A missing --output or command is a usage error (exit 2); an unwritable
// --output is exit 1. `main` returns a Promise of the exit code for this subcommand only.
//
// Config `plan_review.context`: an object { "<cli>": <window in tokens> }, merged per reviewer across
// the two files (project entry, else global entry, else default). A valid entry is a positive integer
// no larger than 10000000; anything else warns and falls through to the next layer; a value that is
// not an object warns and is ignored.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CONFIG_REL = path.join('.trailhead', 'config.json');
const ROSTER = ['claude', 'gemini', 'codex', 'qwen', 'kimi', 'agy', 'opencode', 'cursor-agent', 'coderabbit'];
const DEFAULT_ROUNDS = 2;
const CEILING = 5;
const HOSTS = ['claude', 'codex'];
const CHOICES = ['config', '1', '2', '3', 'until'];
const VALUED = { ask: ['repo', 'host'], round: ['choice', 'configured', 'history'], budget: ['repo', 'reviewer', 'prompt'], overflow: ['output', 'prompt'], run: ['output', 'timeout'] };
// Default context windows in tokens; any other reviewer name gets FALLBACK_WINDOW.
const CONTEXT_WINDOWS = { claude: 200000, gemini: 1000000, codex: 272000, qwen: 256000, kimi: 256000, agy: 1000000, opencode: 128000, 'cursor-agent': 128000, coderabbit: 128000 };
const FALLBACK_WINDOW = 128000;
const MAX_WINDOW = 10000000;
const CAP_RATIO = 0.65;
const BYTES_PER_TOKEN = 3;
const FILE_THRESHOLD_BYTES = 102400;
const REASON_MAX = 200;
// Wall-clock deadline of one reviewer call: above the 540s floor agy already uses. It is wall-clock
// (not a no-output check) because a healthy reviewer may stay quiet for minutes.
const DEFAULT_TIMEOUT_SECONDS = 600;
// Time between SIGTERM and SIGKILL to the reviewer's process group.
const KILL_GRACE_MS = 10000;
// Last resort after SIGKILL: stop waiting for an exit event that never comes.
const EXIT_FALLBACK_MS = 2000;
// Known context-overflow and E2BIG messages of the reviewer CLIs (case-insensitive).
const OVERFLOW_PATTERNS = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /exceeds the context window/i,
  /input is too long/i,
  /input token count .* exceeds the maximum/i,
  /argument list too long/i,
  /E2BIG/i,
];
// A rate-limit error can mention tokens too; it is never a context overflow.
const RATE_LIMIT = /rate.?limit|\b429\b|too many requests/i;

class Usage extends Error {}

function parseArgs(argv) {
  const command = argv[0];
  if (!Object.keys(VALUED).includes(command)) return { error: `usage: first argument must be one of ${Object.keys(VALUED).join(', ')}` };
  const out = { command };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (command === 'run' && a === '--') {
      out.cmd = argv.slice(i + 1);
      break;
    }
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (!name || !VALUED[command].includes(name)) return { error: `usage: unknown argument ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `usage: ${a} needs a value` };
    out[name] = v;
  }
  if (command === 'ask') {
    if (!out.repo) return { error: 'usage: missing --repo <project-root>' };
    if (out.host !== undefined && !HOSTS.includes(out.host)) return { error: `usage: --host must be one of ${HOSTS.join(', ')}` };
  } else if (command === 'budget') {
    if (!out.repo) return { error: 'usage: missing --repo <project-root>' };
    if (!out.reviewer) return { error: 'usage: missing --reviewer <name>' };
    if (!out.prompt) return { error: 'usage: missing --prompt <file>' };
  } else if (command === 'overflow') {
    if (!out.output) return { error: 'usage: missing --output <file>' };
  } else if (command === 'run') {
    if (!out.output) return { error: 'usage: missing --output <file>' };
    if (out.timeout !== undefined && !/^[1-9]\d*$/.test(out.timeout)) return { error: 'usage: --timeout needs a positive integer (seconds)' };
    if (!out.cmd || out.cmd.length === 0 || out.cmd[0] === '') return { error: 'usage: missing command after -- <cmd> [args...]' };
  } else {
    if (!out.choice || !CHOICES.includes(out.choice)) return { error: `usage: --choice must be one of ${CHOICES.join(', ')}` };
    if (!out.configured || !/^[1-9]\d*$/.test(out.configured)) return { error: 'usage: --configured needs a positive integer' };
    if (!out.history) return { error: 'usage: missing --history <file>' };
  }
  return out;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Reads one config file. { cfg } (null when absent) or { error }.
function readFile(file, fs_) {
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { cfg: null };
    return { error: `cannot read ${file}: ${err && err.message ? err.message : err}` };
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { error: `${file} is not valid JSON` };
  }
  if (!isObject(cfg)) return { error: `${file} is not a JSON object` };
  return { cfg };
}

// Su Codex lo script vive in <codexHome>/skills/trailhead/<dir>: la config globale sta lì, non in ~/.claude.
const CODEX_INSTALL = /[\\/]skills[\\/]trailhead[\\/](?:hooks|templates)$/;
const codexHome = () => (CODEX_INSTALL.test(__dirname) ? path.resolve(__dirname, '..', '..', '..') : null);

function globalConfigPath(env) {
  const base = codexHome() || env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

// Effective { planReview, rounds } (undefined when unset) or { error }. Nearest file wins per key.
// `contextLayers` is every file that sets plan_review.context, nearest first (merged per reviewer later).
function readConfig(root, env, fs_) {
  const files = [path.join(root, CONFIG_REL), globalConfigPath(env)];
  const parsed = [];
  for (const file of files) {
    const r = readFile(file, fs_);
    if (r.error) return { error: r.error };
    if (r.cfg) parsed.push({ file, cfg: r.cfg });
  }
  const out = {};
  for (const [key, prop] of [['plan_review', 'planReview'], ['plan_review.rounds', 'rounds']]) {
    const hit = parsed.find(({ cfg }) => has(cfg, key));
    if (hit) out[prop] = { value: hit.cfg[key], file: hit.file };
  }
  out.contextLayers = parsed.filter(({ cfg }) => has(cfg, 'plan_review.context')).map(({ file, cfg }) => ({ value: cfg['plan_review.context'], file }));
  return out;
}

function resolveRounds(entry, warnings) {
  if (!entry) return DEFAULT_ROUNDS;
  const v = entry.value;
  if (Number.isInteger(v) && v > 0) return v;
  warnings.push(`plan_review.rounds in ${entry.file} must be a positive integer; using ${DEFAULT_ROUNDS}`);
  return DEFAULT_ROUNDS;
}

// Pure PATH scan: an executable regular file named `name` in some PATH directory.
function pathLookup(env, fs_) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  return (name) => dirs.some((dir) => {
    const file = path.join(dir, name);
    try {
      return fs_.statSync(file).isFile() && (fs_.accessSync(file, fs_.constants.X_OK), true);
    } catch (err) {
      return false;
    }
  });
}

// `kimi --help` output, or null when it cannot run.
function runKimiHelp() {
  const r = spawnSync('kimi', ['--help'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout || ''}${r.stderr || ''}`;
}

const entry = (value, label, recommended) => ({ value, label, ...(recommended ? { recommended: true } : {}) });
const countLabel = (n) => `${n} round${n === 1 ? '' : 's'}`;

function buildMenus(n) {
  const config = entry('config', `As in config (${n})`, true);
  const until = entry('until', 'Until convergence (stop on a round with no progress, ceiling 5)');
  const count = (k) => entry(String(k), countLabel(k));
  const options = n >= 1 && n <= 3
    ? [config, ...[1, 2, 3].filter((k) => k !== n).map(count), until]
    : [config, count(1), count(2), until];
  const fallback = [config, count(1), count(2), count(3), until];
  return { options, fallback };
}

function runAsk(parsed, cwd, env, fs_, deps) {
  const cfg = readConfig(path.resolve(cwd, parsed.repo), env, fs_);
  if (cfg.error) return { code: 1, result: { status: 'error', reason: cfg.error } };
  const warnings = [];
  const configured = resolveRounds(cfg.rounds, warnings);
  const base = { configured, unknown: [], warnings };

  const raw = cfg.planReview ? cfg.planReview.value : 'off';
  if (typeof raw !== 'string') return { code: 1, result: { status: 'error', reason: `plan_review in ${cfg.planReview.file} must be a string (off, on or a comma list)` } };
  const mode = raw.trim().toLowerCase();
  if (mode === 'off') return { code: 0, result: { status: 'skip', reason: 'off', ...base } };

  const explicit = mode !== 'on';
  const names = explicit ? [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))] : ROSTER;
  if (names.length === 0) return { code: 1, result: { status: 'error', reason: `plan_review in ${cfg.planReview.file} names no CLI` } };

  const which = deps.which || pathLookup(env, fs_);
  const kimiHelp = deps.kimiHelp || runKimiHelp;
  const host = parsed.host || 'claude';
  const reviewers = [];
  const unknown = [];
  for (const name of names) {
    if (name === host) continue;
    const installed = which(name);
    if (!ROSTER.includes(name)) {
      if (installed) reviewers.push(name);
      else {
        unknown.push(name);
        warnings.push(`plan_review names "${name}", which is not a known CLI and has no binary on PATH; it does not count (typo?)`);
      }
      continue;
    }
    if (!installed) continue;
    if (name === 'kimi') {
      const help = kimiHelp();
      if (typeof help !== 'string' || !help.includes('--output-format')) continue;
    }
    reviewers.push(name);
  }
  if (reviewers.length === 0) return { code: 0, result: { status: 'skip', reason: 'no-reviewer', ...base, unknown } };
  return { code: 0, result: { status: 'ask', configured, reviewers, unknown, warnings, ...buildMenus(configured) } };
}

const validWindow = (v) => Number.isInteger(v) && v > 0 && v <= MAX_WINDOW;

// Window for one reviewer: first valid entry across the layers, else the default.
function resolveWindow(layers, reviewer, warnings) {
  for (const { value, file } of layers) {
    if (!isObject(value)) {
      warnings.push(`plan_review.context in ${file} must be an object of CLI name to window tokens; ignored`);
      continue;
    }
    if (!has(value, reviewer)) continue;
    if (validWindow(value[reviewer])) return { window: value[reviewer], windowSource: 'config' };
    warnings.push(`plan_review.context.${reviewer} in ${file} must be a positive integer of at most ${MAX_WINDOW}; ignored`);
  }
  return { window: has(CONTEXT_WINDOWS, reviewer) ? CONTEXT_WINDOWS[reviewer] : FALLBACK_WINDOW, windowSource: 'default' };
}

// Pure decision over the prompt size and the window. First match wins: skip, file, arg.
function budgetDecision(bytes, window) {
  const tokens = Math.ceil(bytes / BYTES_PER_TOKEN);
  const cap = Math.floor(window * CAP_RATIO);
  const decision = tokens > cap ? 'skip' : bytes > FILE_THRESHOLD_BYTES ? 'file' : 'arg';
  return { decision, tokens, cap };
}

function runBudget(parsed, cwd, env, fs_) {
  const cfg = readConfig(path.resolve(cwd, parsed.repo), env, fs_);
  if (cfg.error) return { code: 1, result: { status: 'error', reason: cfg.error } };
  const file = path.resolve(cwd, parsed.prompt);
  let bytes;
  try {
    bytes = fs_.readFileSync(file).length;
  } catch (err) {
    return { code: 1, result: { status: 'error', reason: `cannot read ${file}: ${err && err.message ? err.message : err}` } };
  }
  const warnings = [];
  const { window, windowSource } = resolveWindow(cfg.contextLayers, parsed.reviewer, warnings);
  const { decision, tokens, cap } = budgetDecision(bytes, window);
  const result = { status: 'ok', reviewer: parsed.reviewer, decision, bytes, tokens, window, cap, windowSource };
  if (decision === 'skip') result.reason = `prompt too large for ${parsed.reviewer}: estimated ${tokens} tokens exceeds the cap of ${cap} (65% of its ${window}-token context window)`;
  if (decision === 'file') result.pointer = `Read the complete review brief in ${file} and answer it exactly as it asks.`;
  result.warnings = warnings;
  return { code: 0, result };
}

// Pure match over captured reviewer output: the first line carrying a known overflow message.
// Lines of the brief echoed back by the CLI (matched trimmed) and rate-limit lines never count.
function matchOverflow(text, brief = '') {
  const echoed = new Set(String(brief).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (echoed.has(t) || RATE_LIMIT.test(t)) continue;
    if (OVERFLOW_PATTERNS.some((re) => re.test(t))) return t.slice(0, REASON_MAX);
  }
  return null;
}

function runOverflow(parsed, cwd, fs_) {
  const file = path.resolve(cwd, parsed.output);
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    return { code: 1, result: { status: 'error', reason: `cannot read ${file}: ${err && err.message ? err.message : err}` } };
  }
  let brief = '';
  if (parsed.prompt) {
    const pf = path.resolve(cwd, parsed.prompt);
    try {
      brief = fs_.readFileSync(pf, 'utf8');
    } catch (err) {
      return { code: 1, result: { status: 'error', reason: `cannot read ${pf}: ${err && err.message ? err.message : err}` } };
    }
  }
  const reason = matchOverflow(text, brief);
  return { code: 0, result: reason === null ? { status: 'ok', overflow: false } : { status: 'ok', overflow: true, reason } };
}

// Runs one reviewer call under a wall-clock deadline. Resolves { code, result }; never rejects.
function runRun(parsed, cwd, env, deps) {
  const file = path.resolve(cwd, parsed.output);
  const timeoutSeconds = parsed.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(parsed.timeout);
  const graceMs = deps.graceMs !== undefined ? deps.graceMs : (/^\d+$/.test(env.TRAILHEAD_REVIEW_GRACE_MS || '') ? Number(env.TRAILHEAD_REVIEW_GRACE_MS) : KILL_GRACE_MS);
  const base = { timeoutSeconds, output: file };
  let fd;
  try {
    fd = fs.openSync(file, 'w');
  } catch (e) {
    return Promise.resolve({ code: 1, result: { status: 'error', reason: `cannot write ${file}: ${e && e.message ? e.message : e}` } });
  }
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  const [cmd, ...args] = parsed.cmd;

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let timers = [];
    const killGroup = (sig) => {
      if (!child || !child.pid) return;
      try { process.kill(-child.pid, sig); } catch (e) { /* group already gone */ }
    };
    const onSignal = (sig) => { killGroup('SIGKILL'); process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 143); };
    const finish = (code, result) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGHUP', onSignal);
      try { fs.closeSync(fd); } catch (e) { /* already closed */ }
      resolve({ code, result: { ...result, seconds: seconds(), ...base } });
    };
    const fail = (e) => {
      const text = `trailhead run: cannot launch ${cmd}: ${e && e.message ? e.message : e}`;
      try { fs.writeSync(fd, text + '\n'); } catch (w) { /* the reason still goes in the JSON */ }
      finish(0, { status: 'error', exitCode: null, signal: null, reason: text });
    };

    try {
      child = spawn(cmd, args, { stdio: ['ignore', fd, fd], detached: true, cwd });
    } catch (e) {
      fail(e);
      return;
    }
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    process.once('SIGHUP', onSignal);
    child.on('error', (e) => { if (!child.pid) fail(e); });

    child.on('exit', (exitCode, signal) => {
      // Stragglers of the reviewer's group never outlive the call.
      killGroup('SIGKILL');
      if (timedOut) {
        finish(0, { status: 'timeout', exitCode, signal, reason: `no exit within ${timeoutSeconds}s; the process group was terminated` });
      } else if (exitCode === 0) {
        finish(0, { status: 'ok', exitCode, signal });
      } else {
        finish(0, { status: 'failed', exitCode, signal, reason: signal ? `killed by ${signal}` : `exit code ${exitCode}` });
      }
    });

    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      timers.push(setTimeout(() => {
        killGroup('SIGKILL');
        // Final fallback: do not wait for an exit event a stuck descendant could delay.
        timers.push(setTimeout(() => finish(0, { status: 'timeout', exitCode: null, signal: 'SIGKILL', reason: `no exit within ${timeoutSeconds}s; the process group was killed` }), EXIT_FALLBACK_MS));
      }, graceMs));
    }, timeoutSeconds * 1000));
  });
}

const norm = (key) => key.trim().toLowerCase().replace(/\s+/g, ' ');
const filled = (v) => typeof v === 'string' && v.trim() !== '';

// Validates the history; throws Usage when malformed.
function validateHistory(h) {
  if (!Array.isArray(h) || h.length === 0) throw new Usage('usage: history must be a non-empty JSON array, one entry per round');
  h.forEach((round, i) => {
    if (!Array.isArray(round)) throw new Usage(`usage: history[${i}] must be an array of concerns`);
    round.forEach((c, j) => {
      if (!isObject(c) || !filled(c.key) || !filled(c.text)) throw new Usage(`usage: history[${i}][${j}] must be {"key","text"} with non-empty strings`);
    });
  });
}

function decide(history, choice, configured) {
  const rounds = history.length;
  const latest = history[rounds - 1];
  if (latest.length === 0) return { status: 'ok', decision: 'converged', rounds };
  const stop = (decision) => ({ status: 'ok', decision, rounds, surviving: latest.map((c) => ({ key: c.key, text: c.text })) });
  if (choice === 'until') {
    const prev = rounds >= 2 ? history[rounds - 2] : [];
    const latestKeys = new Set(latest.map((c) => norm(c.key)));
    if (prev.length > 0 && prev.every((c) => latestKeys.has(norm(c.key)))) return stop('no-progress');
    if (rounds >= CEILING) return stop('ceiling');
    return { status: 'ok', decision: 'continue', rounds };
  }
  const limit = choice === 'config' ? configured : Number(choice);
  if (rounds >= limit) return stop('exhausted');
  return { status: 'ok', decision: 'continue', rounds };
}

function runRound(parsed, cwd, fs_) {
  const file = path.resolve(cwd, parsed.history);
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    return { code: 1, result: { status: 'error', reason: `cannot read ${file}: ${err && err.message ? err.message : err}` } };
  }
  let history;
  try {
    history = JSON.parse(text);
  } catch (err) {
    throw new Usage(`usage: ${file} is not valid JSON`);
  }
  validateHistory(history);
  return { code: 0, result: decide(history, parsed.choice, Number(parsed.configured)) };
}

// Returns the exit code, or a Promise of it for the `run` subcommand (the only asynchronous one).
function main(argv, { cwd, stdout, stderr, env, fs: fsMod, which, kimiHelp, graceMs } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const env_ = env || process.env;
  const fs_ = fsMod || fs;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    err.write(parsed.error + '\n');
    return 2;
  }
  if (parsed.command === 'run') {
    return runRun(parsed, cwd_, env_, { graceMs }).then((r) => {
      out.write(JSON.stringify(r.result) + '\n');
      return r.code;
    });
  }
  let run;
  try {
    if (parsed.command === 'ask') run = runAsk(parsed, cwd_, env_, fs_, { which, kimiHelp });
    else if (parsed.command === 'budget') run = runBudget(parsed, cwd_, env_, fs_);
    else if (parsed.command === 'overflow') run = runOverflow(parsed, cwd_, fs_);
    else run = runRound(parsed, cwd_, fs_);
  } catch (e) {
    if (e instanceof Usage) {
      err.write(e.message + '\n');
      return 2;
    }
    run = { code: 1, result: { status: 'error', reason: 'error: ' + (e && e.message ? e.message : String(e)) } };
  }
  out.write(JSON.stringify(run.result) + '\n');
  return run.code;
}

module.exports = { globalConfigPath, parseArgs, readConfig, decide, budgetDecision, matchOverflow, main };

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, env: process.env })).then((code) => process.exit(code));
}
