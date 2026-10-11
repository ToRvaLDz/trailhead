#!/usr/bin/env node
'use strict';
// trailhead work state (self-contained, ships in templates/ so it reaches every
// install channel: bin/trailhead.js copies templates/ wholesale for Claude/npm
// and Codex). Writes and removes <repo>/.trailhead/work-state.json, the state
// of the ticket in play that the skills update at every step. #205.
//
// CLI:
//   node trailhead-work-state.js set [--repo <dir>] [--map <n>|none] [--ticket <n>]
//        [--title <t>] [--step <step>] [--auto true|false] [--auto-done <n>]
//   node trailhead-work-state.js clear [--repo <dir>]
// --repo defaults to cwd. `set` merges the given fields onto the existing file
// (only --step at each step change); a --ticket other than the one on file
// starts from an empty state. File shape:
//   { map, ticket, title, step, auto, autoDone, session, updatedAt }
// autoDone: tickets resolved so far in the autonomous run (non-negative
// integer, default 0; reset to 0 whenever auto is false).
// Prints one JSON line {"status","path","state"?,"message"?}.
//   status: written | cleared | absent | skipped
// Exit 0 on every normal outcome and on any unexpected I/O error (it must
// never block the caller: status skipped with the message); exit 2 only on a
// usage or validation error (nothing is written).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = '.trailhead';
const STATE_FILE = 'work-state.json';
const STEPS = ['discuss', 'plan', 'execute', 'verify', 'resolve', 'paused'];
const TITLE_MAX = 200;

const isPosInt = (v) => Number.isInteger(v) && v > 0;

// Strict parse of a positive integer from a CLI string; null if invalid.
function parsePosInt(text) {
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

// Strict parse of a non-negative integer from a CLI string; null if invalid.
function parseNonNegInt(text) {
  return /^(0|[1-9]\d*)$/.test(text) ? Number(text) : null;
}

// Title on a single line: control characters and newlines become spaces,
// spaces collapsed, trimmed, capped at TITLE_MAX characters.
function cleanTitle(text) {
  return String(text).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, TITLE_MAX);
}

// Keeps only the valid fields of an arbitrary object: an invalid field is
// dropped (treated as absent), never carried into the new state.
function sanitizeState(raw) {
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (raw.map === null || isPosInt(raw.map)) out.map = raw.map;
  if (isPosInt(raw.ticket)) out.ticket = raw.ticket;
  if (typeof raw.title === 'string') out.title = cleanTitle(raw.title);
  if (STEPS.includes(raw.step)) out.step = raw.step;
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  if (Number.isInteger(raw.autoDone) && raw.autoDone >= 0) out.autoDone = raw.autoDone;
  return out;
}

// Merges the patch onto the existing state. A different ticket starts from
// empty (no inherited title/map). Returns the normalised state, or
// { error } when ticket or step is missing.
function mergeState(existing, patch, { session = null, now = new Date() } = {}) {
  const base = sanitizeState(existing);
  const start = patch.ticket !== undefined && base.ticket !== undefined && base.ticket !== patch.ticket ? {} : base;
  const merged = { ...start, ...patch };
  if (merged.ticket === undefined) return { error: 'usage: set needs a ticket (pass --ticket)' };
  if (merged.step === undefined) return { error: 'usage: set needs a step (pass --step)' };
  const auto = merged.auto === undefined ? false : merged.auto;
  return {
    map: merged.map === undefined ? null : merged.map,
    ticket: merged.ticket,
    title: merged.title === undefined || merged.title === '' ? null : merged.title,
    step: merged.step,
    auto,
    // A run that is not autonomous has no counter.
    autoDone: auto && merged.autoDone !== undefined ? merged.autoDone : 0,
    session,
    updatedAt: now.toISOString(),
  };
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== 'set' && command !== 'clear') {
    return { error: `usage: expected "set" or "clear", got: ${command === undefined ? '(nothing)' : command}` };
  }
  let repo = null;
  const patch = {};
  const allowed = command === 'set' ? ['--repo', '--map', '--ticket', '--title', '--step', '--auto', '--auto-done'] : ['--repo'];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const value = argv[i];
    if (flag === '--repo') repo = value;
    else if (flag === '--map') {
      if (value === 'none') patch.map = null;
      else if (parsePosInt(value) !== null) patch.map = parsePosInt(value);
      else return { error: `usage: --map must be a positive integer or "none", got: ${value}` };
    } else if (flag === '--ticket') {
      if (parsePosInt(value) === null) return { error: `usage: --ticket must be a positive integer, got: ${value}` };
      patch.ticket = parsePosInt(value);
    } else if (flag === '--title') patch.title = cleanTitle(value);
    else if (flag === '--step') {
      if (!STEPS.includes(value)) return { error: `usage: --step must be one of ${STEPS.join(', ')}, got: ${value}` };
      patch.step = value;
    } else if (flag === '--auto') {
      if (value !== 'true' && value !== 'false') return { error: `usage: --auto must be true or false, got: ${value}` };
      patch.auto = value === 'true';
    } else if (flag === '--auto-done') {
      if (parseNonNegInt(value) === null) return { error: `usage: --auto-done must be a non-negative integer, got: ${value}` };
      patch.autoDone = parseNonNegInt(value);
    }
  }
  return { command, repo, patch };
}

// Reads the existing file; missing or corrupt = no state (never a crash).
function readExisting(file, fsMod) {
  try {
    return JSON.parse(fsMod.readFileSync(file, 'utf8'));
  } catch {
    return null;
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
    try { fsMod.unlinkSync(tmp); } catch { /* pulizia best effort */ }
    throw err;
  }
}

function writeResult(stdout, result) {
  stdout.write(JSON.stringify(result) + '\n');
}

function main(argv, { cwd, stdout, env, fs: fsMod, now } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const env_ = env || process.env;
  const fs_ = fsMod || fs;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }

  const repoDir = parsed.repo ? path.resolve(cwd_, parsed.repo) : cwd_;
  const dir = path.join(repoDir, STATE_DIR);
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

    const sessionEnv = env_.CLAUDE_CODE_SESSION_ID;
    const session = typeof sessionEnv === 'string' && sessionEnv !== '' ? sessionEnv : null;
    const state = mergeState(readExisting(file, fs_), parsed.patch, { session, now: now || new Date() });
    if (state.error) {
      process.stderr.write(state.error + '\n');
      return 2;
    }
    writeAtomic(dir, file, JSON.stringify(state, null, 2) + '\n', fs_);
    writeResult(out, { status: 'written', path: file, state });
    return 0;
  } catch (err) {
    writeResult(out, { status: 'skipped', path: file, message: 'error: ' + (err && err.message ? err.message : String(err)) });
    return 0;
  }
}

module.exports = { STEPS, sanitizeState, mergeState, parseArgs, main };

if (require.main === module) {
  const code = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, env: process.env });
  process.exit(code);
}
