#!/usr/bin/env node
'use strict';
// trailhead skill discovery (self-contained, ships in templates/ so it reaches every
// install channel: bin/trailhead.js copies templates/ wholesale for Claude/npm and Codex).
// Backs the optional "is there an installed-able skill for this?" search done while
// charting and planning. #426 (decided in #424). Nothing is ever installed or downloaded,
// to detect or to search; a failed search is silent for the caller.
//
// CLI (one JSON line on stdout; exit 0 on every normal outcome, 2 on a usage error):
//   node trailhead-skill-discovery.js sources --repo <root> [--host-search yes|no]
//   node trailhead-skill-discovery.js find     --repo <root> --query <text> [--timeout <s>] [--limit <n>]
//   node trailhead-skill-discovery.js filter   --repo <root> --query <text> --file <json>
//   node trailhead-skill-discovery.js decline  --repo <root> --id <id>
//   node trailhead-skill-discovery.js declined --repo <root>
//
// Config `skills.search` = auto | off (default auto), flat `skills.search` or nested
// `skills: {search}`; the project file (<root>/.trailhead/config.json) over the global one
// (${CLAUDE_CONFIG_DIR:-~/.claude}/trailhead/config.json, the Codex home on a Codex install).
// An invalid value warns and falls to the next layer.
//
// sources: {"status":"off"} under off, else
//   {"status":"ok","sources":[{"name":"host"},{"name":"cli","kind":"binary|npx-cache"}],"warnings":[]}
//   in this order. `host` only with --host-search yes (the agent says whether its own built-in
//   skill/plugin search tool exists; the helper cannot see it). `cli` only when already
//   installed: a `skills` binary on the PATH (kind binary), or the `find-skills` skill in a
//   known skills dir plus npm >= 7 (kind npx-cache: run as `npx --no skills` with
//   npm_config_offline=true, so npx never downloads; a CLI absent from the cache fails and
//   the search is skipped silently).
// find: runs `<cli> find <query>` (argv, no shell) in its own process group under a wall-clock
//   deadline (default 15 s; SIGTERM, then SIGKILL after a grace, TRAILHEAD_SKILLS_GRACE_MS
//   overrides it for tests), parses the `owner/repo@skill <n> installs` + `└ <url>` blocks,
//   and applies the same filter as `filter`. Prints {"status":"ok","matches":[...]}, with
//   "skipped":"<why>" and no matches when nothing could run or the run failed or timed out.
//   {"status":"off","matches":[]} under off, and nothing runs.
// filter: the declined + relevance filter over host-search results ([{id,name,description?}]).
// decline / declined: the decline memory, <project root>/.trailhead/skills-declined.json
//   ({"declined":[ids]}), canonicalised to the main worktree. A refusal or I/O error prints
//   {"status":"skipped","message"} (exit 0). A corrupt file reads as empty.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { prepareRuntimeFile } = require('./trailhead-runtime-dir.js');
const { resolveProjectRoot } = require('./trailhead-isolation-answer.js');

const CONFIG_REL = path.join('.trailhead', 'config.json');
const STATE_FILE = 'skills-declined.json';
const MODES = ['auto', 'off'];
const DEFAULT_TIMEOUT_S = 15;
const DEFAULT_LIMIT = 5;
const KILL_GRACE_MS = 2000;
const EXIT_FALLBACK_MS = 1000;
const MAX_OUTPUT = 1024 * 1024;
const MAX_ID = 200;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'how', 'use', 'using', 'skill', 'skills', 'tool', 'tools', 'your', 'are', 'can', 'any']);
const VALUED = {
  sources: ['repo', 'host-search'],
  find: ['repo', 'query', 'timeout', 'limit'],
  filter: ['repo', 'query', 'file'],
  decline: ['repo', 'id'],
  declined: ['repo'],
};
const REQUIRED = { sources: ['repo'], find: ['repo', 'query'], filter: ['repo', 'query', 'file'], decline: ['repo', 'id'], declined: ['repo'] };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const errText = (e) => (e && e.message ? e.message : String(e));

function parseArgs(argv) {
  const command = argv[0];
  if (!has(VALUED, command)) return { error: `usage: first argument must be one of ${Object.keys(VALUED).join(', ')}` };
  const out = { command };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (!name || !VALUED[command].includes(name)) return { error: `usage: unknown argument ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `usage: ${a} needs a value` };
    out[name] = v;
  }
  for (const k of REQUIRED[command]) if (!out[k] || !out[k].trim()) return { error: `usage: missing --${k}` };
  const hs = out['host-search'];
  if (hs !== undefined && hs !== 'yes' && hs !== 'no') return { error: 'usage: --host-search must be yes or no' };
  for (const k of ['timeout', 'limit']) {
    if (out[k] !== undefined && !/^[1-9]\d*$/.test(out[k])) return { error: `usage: --${k} needs a positive integer` };
  }
  if (command === 'decline' && (out.id.length > MAX_ID || /[\u0000-\u001f]/.test(out.id))) return { error: 'usage: --id is too long or has control characters' };
  return out;
}

// --- config ------------------------------------------------------------------

// Su Codex lo script vive in <codexHome>/skills/trailhead/<dir>: la config globale sta lì.
const CODEX_INSTALL = /[\\/]skills[\\/]trailhead[\\/](?:hooks|templates)$/;
const codexHome = () => (CODEX_INSTALL.test(__dirname) ? path.resolve(__dirname, '..', '..', '..') : null);
const homeOf = (env) => env.HOME || os.homedir();

function globalConfigPath(env) {
  const base = codexHome() || env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

// The raw skills.search of one parsed config, or undefined when unset.
function rawSearch(cfg) {
  if (has(cfg, 'skills.search')) return cfg['skills.search'];
  if (isObject(cfg.skills) && has(cfg.skills, 'search')) return cfg.skills.search;
  return undefined;
}

// Effective { mode, warnings }: nearest valid layer wins, default auto. Never throws.
function resolveMode(root, env, fs_) {
  const warnings = [];
  for (const file of [path.join(root, CONFIG_REL), globalConfigPath(env)]) {
    let cfg;
    try {
      cfg = JSON.parse(fs_.readFileSync(file, 'utf8'));
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) warnings.push(`cannot use ${file}: ${errText(err)}`);
      continue;
    }
    if (!isObject(cfg)) { warnings.push(`${file} is not a JSON object`); continue; }
    const raw = rawSearch(cfg);
    if (raw === undefined) continue;
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
    if (MODES.includes(v)) return { mode: v, warnings };
    warnings.push(`skills.search in ${file} must be auto or off; ignored`);
  }
  return { mode: 'auto', warnings };
}

// --- source detection --------------------------------------------------------

function pathHas(env, fs_, name) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    const file = path.join(dir, name);
    try {
      return fs_.statSync(file).isFile() && (fs_.accessSync(file, fs_.constants.X_OK), true);
    } catch {
      return false;
    }
  });
}

function skillsDirs(root, env) {
  const home = homeOf(env);
  return [
    path.join(root, '.claude', 'skills'),
    path.join(root, '.agents', 'skills'),
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
  ];
}

function hasFindSkills(root, env, fs_) {
  return skillsDirs(root, env).some((d) => {
    try { return fs_.statSync(path.join(d, 'find-skills')).isDirectory(); } catch { return false; }
  });
}

function realNpmMajor(env) {
  const r = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 10000, env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  const m = /^(\d+)\./.exec(String(r.stdout).trim());
  return m ? Number(m[1]) : null;
}

// The cli source, or null: { kind, cmd, args }. Nothing is installed or downloaded.
function detectCli(root, env, fs_, deps) {
  if (pathHas(env, fs_, 'skills')) return { kind: 'binary', cmd: 'skills', args: [] };
  if (!hasFindSkills(root, env, fs_) || !pathHas(env, fs_, 'npx')) return null;
  const major = (deps.npmMajor || realNpmMajor)(env);
  return Number.isInteger(major) && major >= 7 ? { kind: 'npx-cache', cmd: 'npx', args: ['--no', 'skills'] } : null;
}

// npx must never download: offline makes a package absent from the caches fail.
const buildNpxEnv = (env) => ({ ...env, npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });

function runSources(parsed, root, env, fs_, deps) {
  const { mode, warnings } = resolveMode(root, env, fs_);
  if (mode === 'off') return { status: 'off', ...(warnings.length ? { warnings } : {}) };
  const sources = [];
  if (parsed['host-search'] === 'yes') sources.push({ name: 'host' });
  const cli = detectCli(root, env, fs_, deps);
  if (cli) sources.push({ name: 'cli', kind: cli.kind });
  return { status: 'ok', sources, warnings };
}

// --- parsing and relevance ---------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const stripAnsi = (s) => String(s).replace(ANSI, '');

function parseInstalls(text) {
  const m = /^([\d.]+)\s*([KkMm]?)$/.exec(text);
  if (!m) return 0;
  const mult = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Math.round(Number(m[1]) * mult);
}

// `owner/repo@skill 18K installs` + `└ url` blocks -> [{id,name,installs,url}].
function parseResults(raw) {
  const lines = stripAnsi(raw).split(/\r?\n/);
  const out = [];
  const head = /^\s*([\w.-]+\/[\w.-]+@\S+)\s+([\d.]+[KkMm]?)\s+installs?\b/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const next = /^\s*[└╰]─*\s*(https?:\/\/\S+)/.exec(lines[i + 1] || '');
    out.push({ id: m[1], name: m[1].slice(m[1].indexOf('@') + 1), installs: parseInstalls(m[2]), url: next ? next[1] : null });
  }
  return out;
}

const stem = (t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
const tokens = (text) => new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t)).map(stem));

// Declined ids dropped, then only items sharing a meaningful token with the query, ranked by overlap then installs.
function filterItems(items, query, declined, limit) {
  const want = tokens(query);
  const gone = new Set(declined);
  return items
    .filter((it) => it && typeof it.id === 'string' && it.id && !gone.has(it.id))
    .map((it) => {
      const have = tokens([it.id, it.name, it.description].filter((x) => typeof x === 'string').join(' '));
      return { it, overlap: [...want].filter((t) => have.has(t)).length };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.it.installs || 0) - (a.it.installs || 0) || a.it.id.localeCompare(b.it.id))
    .slice(0, limit)
    .map((x) => x.it);
}

// --- decline memory ----------------------------------------------------------

const stateFile = (root) => path.join(root, '.trailhead', STATE_FILE);

// Declined ids; a missing or corrupt file reads as empty. Throws only on a non-ENOENT I/O error.
function readDeclinedStrict(file, fs_) {
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const data = JSON.parse(text);
    const list = isObject(data) && Array.isArray(data.declined) ? data.declined : [];
    return [...new Set(list.filter((x) => typeof x === 'string' && x))];
  } catch {
    return [];
  }
}

function readDeclined(file, fs_) {
  try { return readDeclinedStrict(file, fs_); } catch { return []; }
}

function writeAtomic(file, text, fs_) {
  prepareRuntimeFile(file, fs_);
  const tmp = path.join(path.dirname(file), `.${STATE_FILE}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs_.writeFileSync(tmp, text);
    fs_.renameSync(tmp, file);
  } catch (err) {
    try { fs_.unlinkSync(tmp); } catch { /* pulizia best effort */ }
    throw err;
  }
}

// Union of the record as re-read right before the write and the new id.
function runDecline(parsed, root, fs_) {
  const file = stateFile(root);
  try {
    prepareRuntimeFile(file, fs_);
    const declined = [...new Set([...readDeclinedStrict(file, fs_), parsed.id])];
    writeAtomic(file, JSON.stringify({ declined }, null, 2) + '\n', fs_);
    return { status: 'declined', id: parsed.id, declined, path: file };
  } catch (err) {
    return { status: 'skipped', message: 'error: ' + errText(err) };
  }
}

// --- find --------------------------------------------------------------------

// Runs `cli.cmd ...cli.args find <query>` under a deadline in its own process group.
// Resolves { ok, stdout } or { ok:false, why }; never rejects.
function runCli(cli, query, env, cwd, timeoutS, graceMs) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let out = '';
    const timers = [];
    const killGroup = (sig) => {
      if (!child || !child.pid) return;
      try { process.kill(-child.pid, sig); } catch { /* gruppo già terminato */ }
    };
    const onSignal = (sig) => { killGroup('SIGKILL'); process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 143); };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(s, onSignal);
      if (child && child.stdout) child.stdout.destroy();
      resolve(result);
    };
    try {
      child = spawn(cli.cmd, [...cli.args, 'find', query], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, cwd, env });
    } catch (e) {
      finish({ ok: false, why: 'launch-error' });
      return;
    }
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(s, onSignal);
    child.on('error', () => { if (!child.pid) finish({ ok: false, why: 'launch-error' }); });
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d.toString('utf8'); });
    child.on('exit', (code) => {
      killGroup('SIGKILL'); // gli eventuali figli rimasti non sopravvivono alla chiamata
      if (timedOut) finish({ ok: false, why: 'timeout' });
      else if (code === 0) finish({ ok: true, stdout: out });
      else finish({ ok: false, why: 'failed' });
    });
    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      timers.push(setTimeout(() => {
        killGroup('SIGKILL');
        timers.push(setTimeout(() => finish({ ok: false, why: 'timeout' }), EXIT_FALLBACK_MS));
      }, graceMs));
    }, timeoutS * 1000));
  });
}

const skipped = (why) => ({ status: 'ok', matches: [], skipped: why });

async function runFind(parsed, root, cwd, env, fs_, deps) {
  const { mode, warnings } = resolveMode(root, env, fs_);
  if (mode === 'off') return { status: 'off', matches: [] };
  const cli = detectCli(root, env, fs_, deps);
  if (!cli) return skipped('no-cli');
  const query = parsed.query.replace(/\s+/g, ' ').trim().replace(/^-+/, '').trim();
  if (!query) return skipped('empty-query');
  const timeoutS = parsed.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(parsed.timeout);
  const grace = deps.graceMs !== undefined ? deps.graceMs
    : (/^\d+$/.test(env.TRAILHEAD_SKILLS_GRACE_MS || '') ? Number(env.TRAILHEAD_SKILLS_GRACE_MS) : KILL_GRACE_MS);
  const runEnv = cli.kind === 'npx-cache' ? buildNpxEnv(env) : { ...env };
  const r = await runCli(cli, query, runEnv, cwd, timeoutS, grace);
  if (!r.ok) return skipped(r.why);
  const limit = parsed.limit === undefined ? DEFAULT_LIMIT : Number(parsed.limit);
  const matches = filterItems(parseResults(r.stdout), query, readDeclined(stateFile(root), fs_), limit);
  return { status: 'ok', matches, ...(warnings.length ? { warnings } : {}) };
}

function runFilter(parsed, root, cwd, env, fs_) {
  const { mode } = resolveMode(root, env, fs_);
  if (mode === 'off') return { status: 'off', matches: [] };
  let items;
  try {
    items = JSON.parse(fs_.readFileSync(path.resolve(cwd, parsed.file), 'utf8'));
  } catch (err) {
    return { status: 'skipped', matches: [], message: 'error: ' + errText(err) };
  }
  if (!Array.isArray(items)) return { status: 'skipped', matches: [], message: 'error: --file must hold a JSON array' };
  const matches = filterItems(items, parsed.query, readDeclined(stateFile(root), fs_), Infinity);
  return { status: 'ok', matches };
}

// Returns the exit code, or a Promise of it for `find` (the only asynchronous command).
function main(argv, { cwd, stdout, stderr, env, fs: fsMod, npmMajor, graceMs } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const env_ = env || process.env;
  const fs_ = fsMod || fs;
  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    (stderr || process.stderr).write(parsed.error + '\n');
    return 2;
  }
  const root = resolveProjectRoot(path.resolve(cwd_, parsed.repo));
  const emit = (result) => { out.write(JSON.stringify(result) + '\n'); return 0; };
  const deps = { npmMajor, graceMs };
  if (parsed.command === 'find') {
    return runFind(parsed, root, cwd_, env_, fs_, deps).then(emit, (e) => emit(skipped('error: ' + errText(e))));
  }
  try {
    if (parsed.command === 'sources') return emit(runSources(parsed, root, env_, fs_, deps));
    if (parsed.command === 'filter') return emit(runFilter(parsed, root, cwd_, env_, fs_));
    if (parsed.command === 'decline') return emit(runDecline(parsed, root, fs_));
    const file = stateFile(root);
    return emit({ status: 'ok', declined: readDeclined(file, fs_), path: file });
  } catch (err) {
    return emit({ status: 'skipped', message: 'error: ' + errText(err) });
  }
}

module.exports = { parseArgs, resolveMode, globalConfigPath, detectCli, buildNpxEnv, parseResults, filterItems, stripAnsi, tokens, main };

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, env: process.env })).then((code) => process.exit(code));
}
