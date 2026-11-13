'use strict';
// secret-read-exempt.js: esenzione `secretRead.exempt` del secret-read guard (#376).
// Un progetto elenca in `<git top>/.trailhead/config.json` i path (relativi al repo) di
// placeholder tracciati che hanno un nome da segreto (`.env.local` committato con valori
// finti). Solo il config di progetto conta: quello globale non e' mai letto.
//
// La chiave e' annidata ({"secretRead":{"exempt":[...]}}) o piatta ({"secretRead.exempt":[...]}),
// la annidata vince. Non-array o JSON rotto -> nessuna esenzione. Una voce che non e' una
// stringa non vuota, e' assoluta, ha un carattere glob (`*?[`), un backslash, un segmento
// `..` o `.git`, e' ignorata; un prefisso `./` e i doppi slash sono normalizzati.
//
// Un path e' esente solo se TUTTO regge (qualsiasi errore -> non esente):
//   - coincide con una voce, sotto il top del repo;
//   - e' un file regolare (non un symlink) e nessun suo genitore e' un symlink;
//   - e' tracciato come 100644/100755, non ignorato, e il contenuto e' quello committato
//     (l'indice coincide con HEAD e il file coincide con l'indice).
// Senza voci configurate non parte nessuna chiamata a git.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { gitEnv } = require('./trailhead-git-env.js');

const GIT_TIMEOUT_MS = 5000;
const GLOB_RE = /[*?[]/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function readJson(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(cfg) ? cfg : null;
  } catch {
    return null;
  }
}

// Il primo dir da `cwd` in su che contiene `.git` (cartella o file: worktree), o null.
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

// Valore di `<section>.<key>` in un config letto: annidato vince sul piatto.
// { found, value }.
function pickKey(cfg, section, key) {
  if (!cfg) return { found: false };
  if (isObject(cfg[section]) && has(cfg[section], key)) return { found: true, value: cfg[section][key] };
  if (has(cfg, `${section}.${key}`)) return { found: true, value: cfg[`${section}.${key}`] };
  return { found: false };
}

// Voce normalizzata (separatore `/`, niente `./`), o null se non valida.
function normaliseEntry(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') return null;
  if (entry.includes('\\') || GLOB_RE.test(entry)) return null;
  if (path.isAbsolute(entry) || path.win32.isAbsolute(entry)) return null;
  const segments = entry.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..' || s.toLowerCase() === '.git')) return null;
  return segments.join('/');
}

// Le voci valide di `secretRead.exempt` nel config di progetto sotto `top`.
function loadExemptEntries(top) {
  if (!top) return [];
  const picked = pickKey(readJson(path.join(top, '.trailhead', 'config.json')), 'secretRead', 'exempt');
  if (!picked.found || !Array.isArray(picked.value)) return [];
  return picked.value.map(normaliseEntry).filter((e) => e !== null);
}

// `literal`: pathspec letterali (check-ignore non supporta la magia dei pathspec e la rifiuta
// con exit 128: li' una voce con `:(...)` fallisce chiusa da se', senza il flag).
function git(top, args, literal = true) {
  return execFileSync('git', [...(literal ? ['--literal-pathspecs'] : []), '-C', top, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitEnv(process.env, { GIT_OPTIONAL_LOCKS: '0' }),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  }).toString();
}

// `<mode> <sha> <stage>\t<path>` (ls-files -s -z) o `<mode> <type> <sha>\t<path>` (ls-tree -z):
// un solo record per `rel`, altrimenti null.
function oneRecord(out, rel) {
  const records = out.split('\0').filter(Boolean);
  if (records.length !== 1) return null;
  const tab = records[0].indexOf('\t');
  if (tab === -1 || records[0].slice(tab + 1) !== rel) return null;
  return records[0].slice(0, tab).split(' ');
}

// Vero se `abs` (path assoluto) e' un placeholder esente: vedi l'elenco in testa.
// Mai lancia: ogni errore e' "non esente".
function isExemptPath(abs, top, entries) {
  try {
    if (!abs || !top || !entries || entries.length === 0) return false;
    const rel = path.relative(top, abs).split(path.sep).join('/');
    if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return false;
    if (!entries.includes(rel)) return false;

    // niente symlink nel percorso sotto il top (il top stesso puo' stare dietro un link)
    const realTop = fs.realpathSync(top);
    const file = path.join(realTop, ...rel.split('/'));
    if (!fs.lstatSync(file).isFile()) return false;
    if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) return false;

    const staged = oneRecord(git(realTop, ['ls-files', '-s', '-z', '--', rel]), rel);
    if (!staged || staged.length !== 3 || staged[2] !== '0' || !['100644', '100755'].includes(staged[0])) return false;
    const blob = staged[1];

    const committed = oneRecord(git(realTop, ['ls-tree', '-z', 'HEAD', '--', rel]), rel);
    if (!committed || committed[1] !== 'blob' || committed[2] !== blob) return false;

    // exit 0 = ignorato, 1 = non ignorato, altro = errore: solo 1 lascia passare
    try {
      git(realTop, ['check-ignore', '-q', '--no-index', '--', rel], false);
      return false;
    } catch (err) {
      if (!err || err.status !== 1) return false;
    }

    return git(realTop, ['hash-object', '--', rel]).trim() === blob;
  } catch {
    return false;
  }
}

// Punto d'ingresso del guard: `abs` e' esente nel progetto che contiene `cwd`?
// Prima il config (nessuna chiamata a git senza voci), poi isExemptPath.
function isExemptFor(abs, cwd) {
  try {
    const top = gitTop(cwd);
    if (!top) return false;
    const entries = loadExemptEntries(top);
    return entries.length > 0 && isExemptPath(abs, top, entries);
  } catch {
    return false;
  }
}

module.exports = { readJson, gitTop, pickKey, normaliseEntry, loadExemptEntries, isExemptPath, isExemptFor };
