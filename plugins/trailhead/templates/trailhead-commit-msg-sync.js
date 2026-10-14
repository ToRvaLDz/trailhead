#!/usr/bin/env node
'use strict';
// trailhead commit-msg hook sync (self-contained, ships in templates/ so it
// reaches every install channel: bin/trailhead.js copies templates/ wholesale
// for Claude/npm and Codex alike). Installs the sibling templates into the
// repo's git hooks dir: trailhead-commit-msg (a small sh wrapper, installed as
// commit-msg) and trailhead-commit-msg.cjs (the logic, installed beside it; a
// .cjs is always CommonJS, so a "type": "module" repo cannot break it, #257).
// Upgrades in place when an OLDER trailhead hook (the legacy single-file JS
// one, or an outdated wrapper/.cjs) is already there, recognised by its own
// header line, never by trusting the filename, and never touches a foreign
// (non-trailhead) hook. #185.
//
// CLI: node trailhead-commit-msg-sync.js [--repo <dir>]  (default cwd)
// Prints exactly one JSON line: {"status","hook","message"}.
//   status: installed | upgraded | current | foreign | skipped
//   hook: absolute path to the hook file, or null
// Exit 0 on every normal outcome (including "not a repo" and any unexpected
// error: this must never block the caller); exit 2 only on a usage error
// (unknown flag, or --repo with no value).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Nome del file di logica installato accanto al wrapper commit-msg.
const CJS_NAME = 'trailhead-commit-msg.cjs';

// La riga riconosciuta di ogni versione dell'hook trailhead: basta che una
// delle prime 5 righe (trim) inizi con una di queste stringhe. La prima è
// l'hook JS monofile legacy, la seconda il wrapper sh (layout #257).
const TRAILHEAD_MARKS = ['// trailhead commit-msg hook (git).', '# trailhead commit-msg hook (git).'];

function isTrailheadHook(text) {
  const lines = String(text == null ? '' : text).split('\n').slice(0, 5);
  return lines.some((line) => TRAILHEAD_MARKS.some((mark) => line.trim().startsWith(mark)));
}

// Uniforma i fine riga per il confronto di contenuto: CRLF -> LF, non tocca
// il file su disco (usato solo per decidere current vs upgraded).
function normalize(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

// stdio 'pipe' su tutti e tre i canali: un git fallito (es. "not a repo") non
// deve stampare rumore sul terminale dell'invocante, solo far fallire questa
// chiamata (il chiamante decide come reagire).
function defaultRunGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Risolve la hooksDir effettiva del repo (rispetta core.hooksPath e i
// worktree collegati: `git rev-parse --git-path hooks` la restituisce già
// corretta, eventualmente relativa a cwd). { skip: 'no-repo' } se repoDir non
// è un repo git.
function resolveHooksTarget({ repoDir, runGit = defaultRunGit }) {
  try {
    runGit(['rev-parse', '--git-dir'], repoDir);
  } catch {
    return { skip: 'no-repo' };
  }
  const hooksPathOut = runGit(['rev-parse', '--git-path', 'hooks'], repoDir);
  const hooksDir = path.resolve(repoDir, hooksPathOut);
  let hooksPathSet = false;
  try {
    const value = runGit(['config', '--get', 'core.hooksPath'], repoDir);
    hooksPathSet = Boolean(value && value.trim());
  } catch {
    hooksPathSet = false;
  }
  return { hooksDir, hooksPathSet };
}

// Scrittura atomica: temp file unico nella stessa dir, poi rename sul
// destinazione (mai un truncate in place).
function writeAtomic(fsMod, hooksDir, finalPath, text) {
  const tmpPath = path.join(hooksDir, `.commit-msg.trailhead-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fsMod.writeFileSync(tmpPath, text);
    fsMod.chmodSync(tmpPath, 0o755);
    fsMod.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fsMod.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    throw err;
  }
}

// true se il file esiste, non è un symlink e ha esattamente il contenuto atteso.
function matchesTemplate(fsMod, filePath, text) {
  try {
    if (fsMod.lstatSync(filePath).isSymbolicLink()) return false;
    return normalize(fsMod.readFileSync(filePath, 'utf8')) === normalize(text);
  } catch {
    return false;
  }
}

// Applica la sincronizzazione vera e propria dentro hooksDir. templateText è il
// wrapper sh (installato come commit-msg), cjsText la logica (installata come
// trailhead-commit-msg.cjs). fs è iniettato per testabilità.
function syncCommitMsgHook({ hooksDir, templateText, cjsText, hooksPathSet, fs: fsMod = fs }) {
  const hookPath = path.join(hooksDir, 'commit-msg');
  const cjsPath = path.join(hooksDir, CJS_NAME);

  if (!fsMod.existsSync(hookPath)) {
    if (hooksPathSet) {
      return {
        status: 'skipped',
        hook: null,
        message: 'core.hooksPath is set and has no commit-msg; trailhead does not add files there, copy the template yourself.',
      };
    }
    fsMod.mkdirSync(hooksDir, { recursive: true });
    // Prima la logica, poi il wrapper: mai un wrapper senza il suo script.
    writeAtomic(fsMod, hooksDir, cjsPath, cjsText);
    writeAtomic(fsMod, hooksDir, hookPath, templateText);
    return { status: 'installed', hook: hookPath, message: 'installed the trailhead commit-msg hook.' };
  }

  const stat = fsMod.lstatSync(hookPath);
  if (stat.isSymbolicLink()) {
    return { status: 'foreign', hook: hookPath, message: 'a foreign commit-msg hook (symlink) is present; left untouched.' };
  }

  const existingText = fsMod.readFileSync(hookPath, 'utf8');
  if (!isTrailheadHook(existingText)) {
    return { status: 'foreign', hook: hookPath, message: 'a foreign commit-msg hook is present; left untouched.' };
  }

  const wrapperCurrent = normalize(existingText) === normalize(templateText);
  const cjsCurrent = matchesTemplate(fsMod, cjsPath, cjsText);

  if (wrapperCurrent && cjsCurrent) {
    if ((stat.mode & 0o777) !== 0o755) fsMod.chmodSync(hookPath, 0o755);
    return { status: 'current', hook: hookPath, message: 'the trailhead commit-msg hook is already current.' };
  }

  // Upgrade: logica per prima, wrapper per ultimo (mai un wrapper senza script).
  if (!cjsCurrent) writeAtomic(fsMod, hooksDir, cjsPath, cjsText);
  if (!wrapperCurrent) writeAtomic(fsMod, hooksDir, hookPath, templateText);
  else if ((stat.mode & 0o777) !== 0o755) fsMod.chmodSync(hookPath, 0o755);
  return { status: 'upgraded', hook: hookPath, message: 'upgraded the trailhead commit-msg hook to the current template.' };
}

function parseArgs(argv) {
  let repo = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      i++;
      if (i >= argv.length) return { error: 'usage: --repo requires a value' };
      repo = argv[i];
    } else {
      return { error: `usage: unknown argument: ${arg}` };
    }
  }
  return { repo };
}

function writeResult(stdout, result) {
  stdout.write(JSON.stringify(result) + '\n');
}

function main(argv, { cwd, stdout } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }

  const repoDir = parsed.repo ? path.resolve(cwd_, parsed.repo) : cwd_;
  let hooksDirForError = null;
  try {
    const target = resolveHooksTarget({ repoDir });
    if (target.skip) {
      writeResult(out, { status: 'skipped', hook: null, message: 'not a git repository; nothing to sync.' });
      return 0;
    }
    hooksDirForError = target.hooksDir;
    const templatePath = path.join(__dirname, 'trailhead-commit-msg');
    const templateText = fs.readFileSync(templatePath, 'utf8');
    const cjsText = fs.readFileSync(path.join(__dirname, CJS_NAME), 'utf8');
    const result = syncCommitMsgHook({ hooksDir: target.hooksDir, templateText, cjsText, hooksPathSet: target.hooksPathSet, fs });
    writeResult(out, result);
    return 0;
  } catch (err) {
    const hookGuess = hooksDirForError ? path.join(hooksDirForError, 'commit-msg') : null;
    writeResult(out, { status: 'skipped', hook: hookGuess, message: 'error: ' + (err && err.message ? err.message : String(err)) });
    return 0;
  }
}

module.exports = { CJS_NAME, resolveHooksTarget, isTrailheadHook, normalize, syncCommitMsgHook, parseArgs, main };

if (require.main === module) {
  const code = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout });
  process.exit(code);
}
