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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_REL = path.join('.trailhead', 'config.json');
const ROSTER = ['claude', 'gemini', 'codex', 'qwen', 'kimi', 'agy', 'opencode', 'cursor-agent', 'coderabbit'];
const DEFAULT_ROUNDS = 2;
const CEILING = 5;
const HOSTS = ['claude', 'codex'];
const CHOICES = ['config', '1', '2', '3', 'until'];
const VALUED = { ask: ['repo', 'host'], round: ['choice', 'configured', 'history'] };

class Usage extends Error {}

function parseArgs(argv) {
  const command = argv[0];
  if (!Object.keys(VALUED).includes(command)) return { error: `usage: first argument must be one of ${Object.keys(VALUED).join(', ')}` };
  const out = { command };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (!name || !VALUED[command].includes(name)) return { error: `usage: unknown argument ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `usage: ${a} needs a value` };
    out[name] = v;
  }
  if (command === 'ask') {
    if (!out.repo) return { error: 'usage: missing --repo <project-root>' };
    if (out.host !== undefined && !HOSTS.includes(out.host)) return { error: `usage: --host must be one of ${HOSTS.join(', ')}` };
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

function globalConfigPath(env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

// Effective { planReview, rounds } (undefined when unset) or { error }. Nearest file wins per key.
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

function main(argv, { cwd, stdout, stderr, env, fs: fsMod, which, kimiHelp } = {}) {
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
  let run;
  try {
    run = parsed.command === 'ask' ? runAsk(parsed, cwd_, env_, fs_, { which, kimiHelp }) : runRound(parsed, cwd_, fs_);
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

module.exports = { parseArgs, readConfig, decide, main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, env: process.env }));
}
