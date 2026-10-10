#!/usr/bin/env node
'use strict';
// trailhead work state (self-contained, ships in templates/ così raggiunge ogni
// canale di installazione: bin/trailhead.js copia templates/ in blocco per
// Claude/npm e Codex). Scrive e cancella <repo>/.trailhead/work-state.json,
// lo stato del ticket in lavorazione che le skill aggiornano a ogni step. #205.
//
// CLI:
//   node trailhead-work-state.js set [--repo <dir>] [--map <n>|none] [--ticket <n>]
//        [--title <t>] [--step <step>] [--auto true|false]
//   node trailhead-work-state.js clear [--repo <dir>]
// --repo di default è cwd. `set` fonde i campi passati sul file esistente
// (solo --step a ogni cambio di step); se --ticket indica un ticket diverso
// da quello nel file si riparte da uno stato vuoto. Forma del file:
//   { map, ticket, title, step, auto, session, updatedAt }
// Stampa una riga JSON {"status","path","state"?,"message"?}.
//   status: written | cleared | absent | skipped
// Exit 0 su ogni esito normale e su qualunque errore I/O inatteso (non deve
// mai bloccare il chiamante: status skipped col messaggio); exit 2 solo su
// errore d'uso o di validazione (nulla viene scritto).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = '.trailhead';
const STATE_FILE = 'work-state.json';
const STEPS = ['discuss', 'plan', 'execute', 'verify', 'resolve', 'paused'];
const TITLE_MAX = 200;

const isPosInt = (v) => Number.isInteger(v) && v > 0;

// Parsing stretto di un intero positivo da stringa CLI; null se non valido.
function parsePosInt(text) {
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

// Titolo su una riga sola: controlli e newline diventano spazi, spazi
// collassati, trim, tetto a TITLE_MAX caratteri.
function cleanTitle(text) {
  return String(text).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, TITLE_MAX);
}

// Tiene solo i campi validi di un oggetto arbitrario: un campo non valido è
// scartato (trattato come assente), mai riportato nel nuovo stato.
function sanitizeState(raw) {
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (raw.map === null || isPosInt(raw.map)) out.map = raw.map;
  if (isPosInt(raw.ticket)) out.ticket = raw.ticket;
  if (typeof raw.title === 'string') out.title = cleanTitle(raw.title);
  if (STEPS.includes(raw.step)) out.step = raw.step;
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  return out;
}

// Fonde la patch sullo stato esistente. Un ticket diverso riparte da vuoto
// (niente titolo/map ereditati). Ritorna lo stato normalizzato oppure
// { error } se manca ticket o step.
function mergeState(existing, patch, { session = null, now = new Date() } = {}) {
  const base = sanitizeState(existing);
  const start = patch.ticket !== undefined && base.ticket !== undefined && base.ticket !== patch.ticket ? {} : base;
  const merged = { ...start, ...patch };
  if (merged.ticket === undefined) return { error: 'usage: set needs a ticket (pass --ticket)' };
  if (merged.step === undefined) return { error: 'usage: set needs a step (pass --step)' };
  return {
    map: merged.map === undefined ? null : merged.map,
    ticket: merged.ticket,
    title: merged.title === undefined ? '' : merged.title,
    step: merged.step,
    auto: merged.auto === undefined ? false : merged.auto,
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
  const allowed = command === 'set' ? ['--repo', '--map', '--ticket', '--title', '--step', '--auto'] : ['--repo'];
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
    }
  }
  return { command, repo, patch };
}

// Legge il file esistente; assente o corrotto = nessuno stato (mai un crash).
function readExisting(file, fsMod) {
  try {
    return JSON.parse(fsMod.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Scrittura atomica: temp unico nella stessa dir, poi rename sopra il file
// (mai un truncate in place); il temp è rimosso se qualcosa fallisce.
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
