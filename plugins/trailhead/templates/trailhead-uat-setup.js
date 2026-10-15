#!/usr/bin/env node
'use strict';
// trailhead UAT setup (self-contained, ships in templates/ so it reaches every
// install channel: bin/trailhead.js copies templates/ wholesale for Claude/npm
// and Codex). Reads the project's `uat.setup` / `uat.accounts` config, reports
// what a UAT needs, and runs the setup steps in order. #252.
//
// CLI:
//   node trailhead-uat-setup.js plan --repo <working-root> [--config-root <project-root>]
//   node trailhead-uat-setup.js run  --repo <working-root> [--config-root <project-root>]
//        [--from <i>] [--only <i>] [--ready-timeout <s>] [--step-timeout <s>]
// --config-root is the original checkout the effective config was loaded from
// (defaults to --repo); a worktree/clone workspace never re-resolves config.
//
// Config: `uat.setup` (ordered array of {name, run, check?, note?}) and `uat.accounts`
// ({role: {user, secret}}, secret a bare $ENV reference, never a literal), nested
// ({"uat":{"setup":[...]}}) or flat ({"uat.setup":[...]}); nested wins when a file
// carries both. The project file (read from --config-root) replaces the global one
// (${CLAUDE_CONFIG_DIR:-~/.claude}/trailhead/config.json) key by key as a whole value.
//
// plan: validates, lists the steps (index, name, note, check present) and the $ENV
// names each step / account references with whether each is set. Runs nothing, prints
// no value.
// run: per step, every referenced $NAME / ${NAME} must be set and non-empty (else
// missing-env, nothing runs); a passing `check` -> skipped; else `run` via `sh -c` at
// --repo (non-zero -> failed); with a `check`, poll it after `run` until it passes or
// --ready-timeout (default 60 s) elapses (-> not-ready). Each run/check invocation is
// killed after --step-timeout (default 600 s): a run -> timeout; a check counts as
// failing; while polling, each check is capped at the remaining ready time. Stops at the
// first failing step. A `run`'s output goes to a temp file, never a pipe, so a backgrounded
// process (a dev server) cannot block the helper; it should redirect its own output, else
// it keeps writing to that (deleted) file. A `check`'s output is ignored.
// `$NAME` / `${NAME}` inside single quotes, in a `#` comment or written `\$NAME` is not a
// reference; with an unbalanced quote every `$NAME` counts. Timeouts are capped at 86400 s.
// Prints one JSON line:
//   {"status","steps":[{index,name,result,code?,output?,missing?}],"failedStep"?,
//    "accounts"?,"warnings":[],"message"?}
//   status: unconfigured | none | invalid | ready | failed
//   result: skipped | ran | failed | missing-env | not-ready | timeout
// Only the failing step carries `output`: the last 2000 chars, with the value of every
// referenced variable redacted to its $NAME (best effort, not a guarantee).
// Fail closed: only ready and none let the caller go on; unconfigured goes to the probe.
// Exit 0 whenever a JSON line is printed; exit 2 only on a usage error.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_REL = path.join('.trailhead', 'config.json');
const OUTPUT_TAIL = 2000;
const READ_BYTES = 65536;
const POLL_MS = 500;
const DEFAULT_READY_S = 60;
const DEFAULT_STEP_S = 600;
const MAX_TIMEOUT_S = 86400;
const STEP_KEYS = ['name', 'run', 'check', 'note'];
const ACCOUNT_KEYS = ['user', 'secret'];
const VALUED = ['repo', 'config-root', 'from', 'only', 'ready-timeout', 'step-timeout'];
const COMMANDS = ['plan', 'run'];
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const BARE_REF = /^(?:\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.includes(command)) return { error: `usage: first argument must be one of ${COMMANDS.join(', ')}` };
  const out = { command };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (!name || !VALUED.includes(name)) return { error: `usage: unknown argument ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `usage: ${a} needs a value` };
    out[name] = v;
  }
  if (!out.repo) return { error: 'usage: missing --repo <working-root>' };
  for (const k of ['from', 'only']) {
    if (out[k] !== undefined && !/^\d+$/.test(out[k])) return { error: `usage: --${k} needs a non-negative integer` };
  }
  for (const k of ['ready-timeout', 'step-timeout']) {
    if (out[k] !== undefined && !(Number.isFinite(Number(out[k])) && Number(out[k]) > 0 && Number(out[k]) <= MAX_TIMEOUT_S)) return { error: `usage: --${k} needs a positive number of seconds, at most ${MAX_TIMEOUT_S}` };
  }
  if (out.from !== undefined && out.only !== undefined) return { error: 'usage: --from and --only are exclusive' };
  return out;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// Reads and parses one config file. { state: 'unset' } | { state: 'ok', cfg } | { state: 'invalid', message }
function readFile(file, fs_) {
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'unset' };
    return { state: 'invalid', message: `cannot read ${file}: ${err && err.message ? err.message : err}` };
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { state: 'invalid', message: `${file} is not valid JSON` };
  }
  if (!isObject(cfg)) return { state: 'invalid', message: `${file} is not a JSON object` };
  if (has(cfg, 'uat') && !isObject(cfg.uat)) return { state: 'invalid', message: `uat in ${file} must be an object` };
  return { state: 'ok', cfg };
}

// Picks `uat.<key>` out of a parsed config: { found, value, warning? }.
function pick(cfg, key, file) {
  const nested = isObject(cfg.uat) && has(cfg.uat, key);
  const flat = has(cfg, `uat.${key}`);
  if (!nested && !flat) return { found: false };
  const out = { found: true, value: nested ? cfg.uat[key] : cfg[`uat.${key}`] };
  if (nested && flat) out.warning = `${file} sets uat.${key} in both nested and flat form; the nested form wins`;
  return out;
}

function globalConfigPath(env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

function validateSetup(value, where) {
  if (!Array.isArray(value)) return `uat.setup in ${where} must be an array of steps`;
  for (let i = 0; i < value.length; i++) {
    const s = value[i];
    if (!isObject(s)) return `uat.setup[${i}] in ${where} must be an object`;
    const extra = Object.keys(s).find((k) => !STEP_KEYS.includes(k));
    if (extra) return `uat.setup[${i}] in ${where} has an unknown key: ${extra}`;
    if (!nonEmpty(s.name)) return `uat.setup[${i}] in ${where} needs a non-empty string name`;
    if (!nonEmpty(s.run)) return `uat.setup[${i}] in ${where} needs a non-empty string run`;
    for (const k of ['check', 'note']) {
      if (has(s, k) && !nonEmpty(s[k])) return `uat.setup[${i}].${k} in ${where} must be a non-empty string`;
    }
  }
  return null;
}

function validateAccounts(value, where) {
  if (!isObject(value)) return `uat.accounts in ${where} must be an object of role -> {user, secret}`;
  for (const [role, a] of Object.entries(value)) {
    if (!isObject(a)) return `uat.accounts.${role} in ${where} must be an object`;
    const extra = Object.keys(a).find((k) => !ACCOUNT_KEYS.includes(k));
    if (extra) return `uat.accounts.${role} in ${where} has an unknown key: ${extra}`;
    if (!nonEmpty(a.user)) return `uat.accounts.${role} in ${where} needs a non-empty string user`;
    if (typeof a.secret !== 'string' || !BARE_REF.test(a.secret)) {
      return `uat.accounts.${role}.secret in ${where} must be a bare $ENV reference ($NAME or \${NAME}), never a literal`;
    }
  }
  return null;
}

const VALIDATORS = { setup: validateSetup, accounts: validateAccounts };

// Effective { setup, accounts } (undefined when unset) or { error }. The project file
// replaces the global one key by key as a whole value.
function readConfig(configRoot, env, fs_, warnings) {
  const files = [path.join(configRoot, CONFIG_REL), globalConfigPath(env)];
  const parsed = [];
  for (const file of files) {
    const r = readFile(file, fs_);
    if (r.state === 'invalid') return { error: r.message };
    parsed.push({ file, cfg: r.state === 'ok' ? r.cfg : null });
  }
  const out = {};
  for (const key of ['setup', 'accounts']) {
    for (const { file, cfg } of parsed) {
      if (!cfg) continue;
      const p = pick(cfg, key, file);
      if (!p.found) continue;
      const problem = VALIDATORS[key](p.value, file);
      if (problem) return { error: problem };
      if (p.warning) warnings.push(p.warning);
      out[key] = p.value;
      break;
    }
  }
  return out;
}

// Text with the spans that are never env references blanked out: single-quoted spans
// and backslash-escaped characters (`\$`) and comments (a `#` at a word start outside quotes,
// to end of line). A single quote inside double quotes is literal. Fail closed: a quote span
// still open at the end drops every exemption, so every `$NAME` counts.
function liveText(t) {
  let out = '';
  let single = false;
  let double = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (single) {
      if (c === "'") single = false;
      out += ' ';
    } else if (c === '\\') {
      i++;
      out += '  ';
    } else if (c === '#' && !double && (i === 0 || /[\s;&|()]/.test(t[i - 1]))) {
      while (i < t.length && t[i] !== '\n') { out += ' '; i++; }
      if (i < t.length) out += '\n';
    } else if (c === "'" && !double) {
      single = true;
      out += ' ';
    } else {
      if (c === '"') double = !double;
      out += c;
    }
  }
  return single || double ? t : out;
}

function refsOf(...texts) {
  const names = [];
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const m of liveText(t).matchAll(REF)) {
      const n = m[1] || m[2];
      if (!names.includes(n)) names.push(n);
    }
  }
  return names;
}

const bareName = (s) => { const m = BARE_REF.exec(s); return m ? m[1] || m[2] : null; };

function describe(setup, accounts, env) {
  const state = (name) => ({ name, set: typeof env[name] === 'string' && env[name] !== '' });
  const steps = setup.map((s, index) => ({
    index,
    name: s.name,
    ...(s.note ? { note: s.note } : {}),
    check: Boolean(s.check),
    env: refsOf(s.run, s.check).map(state),
  }));
  const accts = Object.entries(accounts).map(([role, a]) => {
    const userEnv = bareName(a.user);
    return { role, user: userEnv ? null : a.user, userEnv: userEnv ? state(userEnv) : null, secretEnv: state(bareName(a.secret)) };
  });
  return { steps, accounts: accts };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Redacts the value of every referenced variable to its $NAME, longest value first.
function redactor(names, env) {
  const pairs = names
    .filter((n) => typeof env[n] === 'string' && env[n] !== '')
    .map((n) => [n, env[n]])
    .sort((a, b) => b[1].length - a[1].length);
  return (text) => pairs.reduce((t, [n, v]) => t.split(v).join(`$${n}`), text);
}

// Runs `sh -c command` at repo; the output of a `run` goes to a temp file (a check's is ignored). Returns
// { code, timedOut, tail } where tail is the bounded last chunk of the output.
function sh(command, repo, env, timeoutMs, wantOutput) {
  const timeout = Math.max(1, Math.ceil(timeoutMs));
  if (!wantOutput) {
    const r = spawnSync('sh', ['-c', command], { cwd: repo, env, stdio: 'ignore', timeout, killSignal: 'SIGKILL' });
    const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
    return { code: r.status, timedOut, spawnError: r.error && !timedOut ? r.error.message : null, tail: '' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-uat-'));
  const file = path.join(dir, 'out');
  const fd = fs.openSync(file, 'w');
  try {
    const r = spawnSync('sh', ['-c', command], { cwd: repo, env, stdio: ['ignore', fd, fd], timeout, killSignal: 'SIGKILL' });
    const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
    const res = { code: r.status, timedOut, spawnError: r.error && !timedOut ? r.error.message : null, tail: '' };
    if (wantOutput) {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, READ_BYTES);
      const buf = Buffer.alloc(len);
      const rfd = fs.openSync(file, 'r');
      try { fs.readSync(rfd, buf, 0, len, size - len); } finally { fs.closeSync(rfd); }
      res.tail = buf.toString('utf8');
    }
    return res;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const passes = (r) => !r.timedOut && !r.spawnError && r.code === 0;

function finalTail(text, redact, extra) {
  const t = redact(text) + (extra || '');
  return t.length > OUTPUT_TAIL ? '...' + t.slice(t.length - OUTPUT_TAIL) : t;
}

function runStep(step, index, ctx) {
  const { repo, env, stepMs, readyMs, redact } = ctx;
  const base = { index, name: step.name };
  const missing = refsOf(step.run, step.check).filter((n) => typeof env[n] !== 'string' || env[n] === '');
  if (missing.length > 0) return { ...base, result: 'missing-env', missing };
  if (step.check && passes(sh(step.check, repo, env, stepMs, false))) return { ...base, result: 'skipped' };
  const r = sh(step.run, repo, env, stepMs, true);
  if (r.timedOut) return { ...base, result: 'timeout', output: finalTail(r.tail, redact, `\n(timed out after ${stepMs / 1000}s)`) };
  if (r.spawnError || r.code !== 0) {
    return { ...base, result: 'failed', code: r.code, output: finalTail(r.tail, redact, r.spawnError ? `\n${r.spawnError}` : '') };
  }
  if (!step.check) return { ...base, result: 'ran' };
  const deadline = Date.now() + readyMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (passes(sh(step.check, repo, env, Math.max(1, Math.min(stepMs, remaining)), false))) return { ...base, result: 'ran' };
    const left = deadline - Date.now();
    if (left <= 0) break;
    sleep(Math.min(POLL_MS, left));
  }
  return { ...base, result: 'not-ready', output: finalTail(r.tail, redact, `\n(check "${step.check}" did not pass within ${readyMs / 1000}s)`) };
}

function execute(parsed, cwd, env, fs_) {
  const repo = path.resolve(cwd, parsed.repo);
  const configRoot = path.resolve(cwd, parsed['config-root'] || parsed.repo);
  const warnings = [];
  const result = { status: 'invalid', steps: [], warnings };
  const cfg = readConfig(configRoot, env, fs_, warnings);
  if (cfg.error) return { ...result, message: cfg.error };

  const accounts = cfg.accounts || {};
  const merged = { ...process.env, ...env };
  const view = describe(cfg.setup || [], accounts, merged);
  const accountsOut = view.accounts.length > 0 ? { accounts: view.accounts } : {};
  if (cfg.setup === undefined) return { ...result, status: 'unconfigured', ...accountsOut };
  if (cfg.setup.length === 0) return { ...result, status: 'none', ...accountsOut };

  if (parsed.command === 'plan') return { ...result, status: 'ready', steps: view.steps, ...accountsOut };

  const total = cfg.setup.length;
  const pickIndex = parsed.only !== undefined ? Number(parsed.only) : parsed.from !== undefined ? Number(parsed.from) : 0;
  if (pickIndex >= total) return { ...result, message: `step index ${pickIndex} is out of range (${total} steps)` };
  const indexes = parsed.only !== undefined ? [pickIndex] : cfg.setup.map((_, i) => i).filter((i) => i >= pickIndex);

  const names = [...new Set([...view.steps.flatMap((s) => s.env.map((e) => e.name)), ...view.accounts.flatMap((a) => [a.userEnv, a.secretEnv].filter(Boolean).map((e) => e.name))])];
  const ctx = {
    repo,
    env: merged,
    stepMs: Number(parsed['step-timeout'] || DEFAULT_STEP_S) * 1000,
    readyMs: Number(parsed['ready-timeout'] || DEFAULT_READY_S) * 1000,
    redact: redactor(names, merged),
  };
  for (const i of indexes) {
    let r;
    try {
      r = runStep(cfg.setup[i], i, ctx);
    } catch (err) {
      return { ...result, message: 'error: ' + (err && err.message ? err.message : String(err)) };
    }
    result.steps.push(r);
    if (!['skipped', 'ran'].includes(r.result)) return { ...result, status: 'failed', failedStep: i };
  }
  return { ...result, status: 'ready' };
}

function main(argv, { cwd, stdout, env, fs: fsMod } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const env_ = env || process.env;
  const fs_ = fsMod || fs;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }
  let result;
  try {
    result = execute(parsed, cwd_, env_, fs_);
  } catch (err) {
    result = { status: 'invalid', steps: [], warnings: [], message: 'error: ' + (err && err.message ? err.message : String(err)) };
  }
  out.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { parseArgs, readConfig, main };

if (require.main === module) {
  const code = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, env: process.env });
  process.exit(code);
}
