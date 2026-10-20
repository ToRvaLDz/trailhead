#!/usr/bin/env node
'use strict';
// trailhead auto run record (self-contained, ships in templates/ so it reaches
// every install channel: bin/trailhead.js copies templates/ wholesale for
// Claude/npm and Codex). Persists the start-up choices and the working lists of
// an autonomous run in <repo>/.trailhead/auto-run.json, so a run survives a
// context compaction (and a crash) without asking again. #295.
// Written at the main checkout only, never in a slot workspace.
//
// CLI:
//   node trailhead-auto-run.js start --repo <dir> --scope <s> --slots <n> --review <r> [--replace]
//   node trailhead-auto-run.js read --repo <dir>
//   node trailhead-auto-run.js skip --repo <dir> --ticket <n>
//   node trailhead-auto-run.js unmerged --repo <dir> --ticket <n> --branch <b>
//        [--file <path> ...] [--merge-ticket <n>]
//   node trailhead-auto-run.js clear --repo <dir>
// --repo defaults to cwd. File shape:
//   { version: 1, scope, slots, review, session, skip: [<n>...],
//     unmerged: [{ ticket, branch, files: [...], mergeTicket: <n>|null }],
//     startedAt, updatedAt }
// scope: map:<n> | whiteboard | everything (trailhead-auto-queue.js tokens).
// slots: 1 to 4. review: config | 1 | 2 | 3 | until (plan-review-rounds
// tokens) or skip (the ask was skipped). session: CLAUDE_CODE_SESSION_ID at
// start (null when unset, as on Codex).
// Prints one JSON line {"status","path","record"?,"sameSession"?,"message"?}.
//   start:    written | exists (record on file, kept unless --replace) | skipped
//   read:     found (+ sameSession) | absent | corrupt | skipped
//   skip, unmerged: written | absent | corrupt | skipped
//   clear:    cleared | absent | skipped
// A corrupt file (unparseable, or an invalid version/scope/slots/review) is
// reported and never rewritten except by `start --replace`; invalid list
// entries (skip, unmerged) are dropped from an otherwise found record.
// Exit 0 on every normal outcome and on any unexpected I/O error (it must never
// block the run: status skipped with the message); exit 2 only on a usage or
// validation error (nothing is written).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = '.trailhead';
const STATE_FILE = 'auto-run.json';
const VERSION = 1;
const REVIEWS = ['config', '1', '2', '3', 'until', 'skip'];
const SCOPE_RE = /^(map:[1-9]\d*|whiteboard|everything)$/;
const COMMANDS = ['start', 'read', 'skip', 'unmerged', 'clear'];
const FLAGS = {
  start: ['--repo', '--scope', '--slots', '--review', '--replace'],
  read: ['--repo'],
  skip: ['--repo', '--ticket'],
  unmerged: ['--repo', '--ticket', '--branch', '--file', '--merge-ticket'],
  clear: ['--repo'],
};

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isLine = (v) => typeof v === 'string' && v.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(v);

// Strict parse of a positive integer from a CLI string; null if invalid.
function parsePosInt(text) {
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

// Lista di ticket: solo interi positivi, senza doppioni, in ordine crescente.
function cleanTickets(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(isPosInt))].sort((a, b) => a - b);
}

// Una voce unmerged valida o null (la voce invalida viene scartata).
function cleanUnmerged(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isPosInt(raw.ticket) || !isLine(raw.branch)) return null;
  return {
    ticket: raw.ticket,
    branch: raw.branch.trim(),
    files: Array.isArray(raw.files) ? raw.files.filter(isLine) : [],
    mergeTicket: isPosInt(raw.mergeTicket) ? raw.mergeTicket : null,
  };
}

// Una voce per ticket (l'ultima vince), in ordine di ticket.
function cleanUnmergedList(list) {
  if (!Array.isArray(list)) return [];
  const byTicket = new Map();
  for (const item of list) {
    const entry = cleanUnmerged(item);
    if (entry) byTicket.set(entry.ticket, entry);
  }
  return [...byTicket.values()].sort((a, b) => a.ticket - b.ticket);
}

// Normalizza un oggetto qualunque in un record. Un campo obbligatorio invalido
// (version, scope, slots, review) rende il record corrotto: { error }.
function sanitizeRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object' };
  if (raw.version !== VERSION) return { error: 'invalid version' };
  if (typeof raw.scope !== 'string' || !SCOPE_RE.test(raw.scope)) return { error: 'invalid scope' };
  if (!Number.isInteger(raw.slots) || raw.slots < 1 || raw.slots > 4) return { error: 'invalid slots' };
  if (!REVIEWS.includes(raw.review)) return { error: 'invalid review' };
  return {
    record: {
      version: VERSION,
      scope: raw.scope,
      slots: raw.slots,
      review: raw.review,
      session: typeof raw.session === 'string' && raw.session !== '' ? raw.session : null,
      skip: cleanTickets(raw.skip),
      unmerged: cleanUnmergedList(raw.unmerged),
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    },
  };
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.includes(command)) {
    return { error: `usage: expected one of ${COMMANDS.join(', ')}, got: ${command === undefined ? '(nothing)' : command}` };
  }
  const allowed = FLAGS[command];
  const out = { command, repo: null, replace: false, files: [] };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) return { error: `usage: unknown argument: ${flag}` };
    if (flag === '--replace') { out.replace = true; continue; }
    i++;
    if (i >= argv.length) return { error: `usage: ${flag} requires a value` };
    const value = argv[i];
    if (flag === '--repo') out.repo = value;
    else if (flag === '--scope') {
      if (!SCOPE_RE.test(value)) return { error: `usage: --scope must be map:<n>, whiteboard or everything, got: ${value}` };
      out.scope = value;
    } else if (flag === '--slots') {
      const n = parsePosInt(value);
      if (n === null || n > 4) return { error: `usage: --slots must be 1 to 4, got: ${value}` };
      out.slots = n;
    } else if (flag === '--review') {
      if (!REVIEWS.includes(value)) return { error: `usage: --review must be one of ${REVIEWS.join(', ')}, got: ${value}` };
      out.review = value;
    } else if (flag === '--ticket') {
      if (parsePosInt(value) === null) return { error: `usage: --ticket must be a positive integer, got: ${value}` };
      out.ticket = parsePosInt(value);
    } else if (flag === '--merge-ticket') {
      if (parsePosInt(value) === null) return { error: `usage: --merge-ticket must be a positive integer, got: ${value}` };
      out.mergeTicket = parsePosInt(value);
    } else if (flag === '--branch') {
      if (!isLine(value)) return { error: 'usage: --branch must be a single non-empty line' };
      out.branch = value.trim();
    } else if (flag === '--file') {
      if (!isLine(value)) return { error: 'usage: --file must be a single non-empty line' };
      out.files.push(value);
    }
  }
  const missing = { start: ['scope', 'slots', 'review'], skip: ['ticket'], unmerged: ['ticket', 'branch'] }[command] || [];
  for (const key of missing) {
    if (out[key] === undefined) return { error: `usage: ${command} needs --${key}` };
  }
  return out;
}

// Legge il file: { status: 'absent' } | { status: 'corrupt', message } | { status: 'found', record }.
// Un errore di I/O (non di parsing) risale al chiamante, che risponde skipped.
function readFile(file, fsMod) {
  if (!fsMod.existsSync(file)) return { status: 'absent' };
  const text = fsMod.readFileSync(file, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { status: 'corrupt', message: 'unparseable: ' + err.message };
  }
  const s = sanitizeRecord(raw);
  return s.error ? { status: 'corrupt', message: s.error } : { status: 'found', record: s.record };
}

// Scrittura atomica: temp univoco nella stessa cartella, poi rename sul file;
// il temp viene rimosso se qualcosa fallisce.
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

function main(argv, { cwd, stdout, stderr, env, fs: fsMod, now } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const err_ = stderr || process.stderr;
  const env_ = env || process.env;
  const fs_ = fsMod || fs;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    err_.write(parsed.error + '\n');
    return 2;
  }

  const repoDir = parsed.repo ? path.resolve(cwd_, parsed.repo) : cwd_;
  const dir = path.join(repoDir, STATE_DIR);
  const file = path.join(dir, STATE_FILE);
  const stamp = (now || new Date()).toISOString();
  const save = (record) => writeAtomic(dir, file, JSON.stringify(record, null, 2) + '\n', fs_);

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
    const existing = readFile(file, fs_);

    if (parsed.command === 'read') {
      if (existing.status !== 'found') {
        const result = { status: existing.status, path: file };
        if (existing.message) result.message = existing.message;
        writeResult(out, result);
        return 0;
      }
      const sameSession = session !== null && existing.record.session !== null && existing.record.session === session;
      writeResult(out, { status: 'found', path: file, record: existing.record, sameSession });
      return 0;
    }

    if (parsed.command === 'start') {
      if (existing.status !== 'absent' && !parsed.replace) {
        // Un record corrotto non si sovrascrive in silenzio: serve --replace.
        writeResult(out, { status: 'exists', path: file, record: existing.record || null, ...(existing.message ? { message: existing.message } : {}) });
        return 0;
      }
      const record = {
        version: VERSION,
        scope: parsed.scope,
        slots: parsed.slots,
        review: parsed.review,
        session,
        skip: [],
        unmerged: [],
        startedAt: stamp,
        updatedAt: stamp,
      };
      save(record);
      writeResult(out, { status: 'written', path: file, record });
      return 0;
    }

    // skip / unmerged: servono un record leggibile.
    if (existing.status !== 'found') {
      const result = { status: existing.status, path: file };
      if (existing.message) result.message = existing.message;
      writeResult(out, result);
      return 0;
    }
    const base = existing.record;
    const next = parsed.command === 'skip'
      ? { ...base, skip: cleanTickets([...base.skip, parsed.ticket]) }
      : {
        ...base,
        unmerged: cleanUnmergedList([
          ...base.unmerged,
          { ticket: parsed.ticket, branch: parsed.branch, files: parsed.files, mergeTicket: parsed.mergeTicket === undefined ? null : parsed.mergeTicket },
        ]),
      };
    const record = { ...next, updatedAt: stamp };
    save(record);
    writeResult(out, { status: 'written', path: file, record });
    return 0;
  } catch (err) {
    writeResult(out, { status: 'skipped', path: file, message: 'error: ' + (err && err.message ? err.message : String(err)) });
    return 0;
  }
}

module.exports = { REVIEWS, sanitizeRecord, parseArgs, main };

if (require.main === module) {
  const code = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, env: process.env });
  process.exit(code);
}
