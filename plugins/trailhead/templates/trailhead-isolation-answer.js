#!/usr/bin/env node
'use strict';
// trailhead isolation answer (self-contained, ships in templates/ so it reaches
// every install channel: bin/trailhead.js copies templates/ wholesale for
// Claude/npm and Codex). Remembers the answer to the work-start concurrency ask
// under `isolation: auto` in <project root>/.trailhead/isolation-answer.json, so
// later work-starts of the same working stretch reuse it. #245.
//
// CLI:
//   node trailhead-isolation-answer.js check  [--repo <dir>] --others <csv|none|unavailable>
//   node trailhead-isolation-answer.js record [--repo <dir>] --answer yes|no --others <csv|none>
//   node trailhead-isolation-answer.js clear  [--repo <dir>]
// --repo defaults to cwd. It is canonicalised to the project root: inside a
// linked worktree it resolves to the main worktree (git common dir), so a call
// from a trailhead/t<n> worktree reads the same record; on a git failure (or not
// a git repo) the given dir is used as is.
// File shape: { answer: "yes"|"no", others: [ticket numbers], recordedAt, usedAt }
// `others` is the live-claims fingerprint (open issues assigned to @me minus the
// current ticket), sorted and deduplicated; `none` is the empty set.
// A session is a working stretch: it ends after 8 hours without a work-start
// (sliding idle window; each reuse refreshes usedAt).
// check prints:
//   {"status":"reuse","answer","recordedAt","path"}   (only after usedAt was refreshed)
//   {"status":"ask","reason":"absent|expired|claims-changed|invalid|unavailable","path"}
// record prints {"status":"written","path","record"}; clear prints
// {"status":"cleared|absent","path"}.
// Exit 0 on every normal outcome and on any unexpected I/O error (status
// skipped with a message, which the caller treats as ask); exit 2 only on a
// usage error (nothing is written).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const STATE_DIR = '.trailhead';
const STATE_FILE = 'isolation-answer.json';
const IDLE_WINDOW_MS = 8 * 60 * 60 * 1000;
const ANSWERS = ['yes', 'no'];

const isPosInt = (v) => Number.isInteger(v) && v > 0;

// Sorted, deduplicated copy of a list of ticket numbers.
const normalise = (list) => [...new Set(list)].sort((a, b) => a - b);

// Strict parse of the --others value. Returns a sorted deduplicated array,
// the string "unavailable" (when allowed), or null if invalid.
function parseOthers(text, { allowUnavailable }) {
  if (text === 'none') return [];
  if (text === 'unavailable') return allowUnavailable ? 'unavailable' : null;
  if (typeof text !== 'string' || !/^[1-9]\d*(,[1-9]\d*)*$/.test(text)) return null;
  return normalise(text.split(',').map(Number));
}

// Strict ISO timestamp -> epoch ms, or null.
function parseTime(text) {
  if (typeof text !== 'string') return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

// Valid record or null (malformed or future timestamp, answer not yes/no,
// others not an array of positive integers).
function validateRecord(raw, nowMs) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!ANSWERS.includes(raw.answer)) return null;
  if (!Array.isArray(raw.others) || !raw.others.every(isPosInt)) return null;
  const recordedAt = parseTime(raw.recordedAt);
  const usedAt = parseTime(raw.usedAt);
  if (recordedAt === null || usedAt === null) return null;
  if (recordedAt > nowMs || usedAt > nowMs) return null;
  return { answer: raw.answer, others: normalise(raw.others), recordedAt: raw.recordedAt, usedAt, usedAtText: raw.usedAt };
}

// Pure decision: reuse the record or ask again, and why.
// record: parsed file content (null/undefined = absent); others: array or "unavailable".
function decide(record, others, now) {
  if (others === 'unavailable') return { status: 'ask', reason: 'unavailable' };
  if (record === null || record === undefined) return { status: 'ask', reason: 'absent' };
  const valid = validateRecord(record, now.getTime());
  if (valid === null) return { status: 'ask', reason: 'invalid' };
  if (now.getTime() - valid.usedAt > IDLE_WINDOW_MS) return { status: 'ask', reason: 'expired' };
  const want = normalise(others);
  const same = want.length === valid.others.length && want.every((n, i) => n === valid.others[i]);
  if (!same) return { status: 'ask', reason: 'claims-changed' };
  return { status: 'reuse', answer: valid.answer, recordedAt: valid.recordedAt };
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== 'check' && command !== 'record' && command !== 'clear') {
    return { error: `usage: expected "check", "record" or "clear", got: ${command === undefined ? '(nothing)' : command}` };
  }
  const allowed = command === 'check' ? ['--repo', '--others']
    : command === 'record' ? ['--repo', '--answer', '--others'] : ['--repo'];
  let repo = null;
  let answer;
  let others;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const value = argv[i];
    if (flag === '--repo') repo = value;
    else if (flag === '--answer') {
      if (!ANSWERS.includes(value)) return { error: `usage: --answer must be yes or no, got: ${value}` };
      answer = value;
    } else if (flag === '--others') {
      others = parseOthers(value, { allowUnavailable: command === 'check' });
      if (others === null) {
        return { error: `usage: --others must be comma-separated positive integers, "none"${command === 'check' ? ' or "unavailable"' : ''}, got: ${value}` };
      }
    }
  }
  if (command === 'check' && others === undefined) return { error: 'usage: check needs --others' };
  if (command === 'record' && answer === undefined) return { error: 'usage: record needs --answer' };
  if (command === 'record' && others === undefined) return { error: 'usage: record needs --others' };
  return { command, repo, answer, others };
}

// Project root: the main worktree when dir is inside a linked worktree, else
// dir as given (also on any git failure or when not a git repo).
function resolveProjectRoot(dir) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common && path.basename(common) === '.git') return path.dirname(common);
    return dir;
  } catch {
    return dir;
  }
}

// Reads and parses the file; missing = null, corrupt = {} (invalid, never a crash).
function readRecord(file, fsMod) {
  let text;
  try {
    text = fsMod.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Atomic write: a unique temp in the same dir, then rename over the file
// (never an in-place truncate); the temp is removed if anything fails.
function writeAtomic(dir, file, text, fsMod) {
  fsMod.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${STATE_FILE}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fsMod.writeFileSync(tmp, text);
    fsMod.renameSync(tmp, file);
  } catch (err) {
    try { fsMod.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function writeResult(stdout, result) {
  stdout.write(JSON.stringify(result) + '\n');
}

function main(argv, { cwd, stdout, env, fs: fsMod, now } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const fs_ = fsMod || fs;
  const now_ = now || new Date();
  void env;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }

  const repoDir = parsed.repo ? path.resolve(cwd_, parsed.repo) : cwd_;
  const root = resolveProjectRoot(repoDir);
  const dir = path.join(root, STATE_DIR);
  const file = path.join(dir, STATE_FILE);
  try {
    if (parsed.command === 'clear') {
      if (!fs_.existsSync(file)) {
        writeResult(out, { status: 'absent', path: file });
        return 0;
      }
      fs_.unlinkSync(file);
      writeResult(out, { status: 'cleared', path: file });
      return 0;
    }

    if (parsed.command === 'record') {
      const record = { answer: parsed.answer, others: parsed.others, recordedAt: now_.toISOString(), usedAt: now_.toISOString() };
      writeAtomic(dir, file, JSON.stringify(record, null, 2) + '\n', fs_);
      writeResult(out, { status: 'written', path: file, record });
      return 0;
    }

    const raw = readRecord(file, fs_);
    const decision = decide(raw, parsed.others, now_);
    if (decision.status !== 'reuse') {
      writeResult(out, { ...decision, path: file });
      return 0;
    }
    // Slide the idle window first: reuse is only reported once it is persisted.
    const refreshed = { ...raw, usedAt: now_.toISOString() };
    writeAtomic(dir, file, JSON.stringify(refreshed, null, 2) + '\n', fs_);
    writeResult(out, { ...decision, path: file });
    return 0;
  } catch (err) {
    writeResult(out, { status: 'skipped', path: file, message: 'error: ' + (err && err.message ? err.message : String(err)) });
    return 0;
  }
}

module.exports = { IDLE_WINDOW_MS, decide, parseOthers, parseArgs, resolveProjectRoot, main };

if (require.main === module) {
  const code = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, env: process.env });
  process.exit(code);
}
