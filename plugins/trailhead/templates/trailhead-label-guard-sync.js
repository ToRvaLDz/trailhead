#!/usr/bin/env node
'use strict';
// trailhead label guard sync (self-contained, ships in templates/ so it
// reaches every install channel). Classifies the repo's
// .github/workflows/trailhead-label-guard.yml against the sibling template
// and, with --apply, installs it when absent or upgrades an OUTDATED trailhead
// guard (one without the job-level `if:` filter, so every `issues: labeled`
// event started a billed runner). Never touches a foreign or customised guard.
//
// CLI: node trailhead-label-guard-sync.js [--repo <dir>] [--apply | --notice | --ack]
// Default and --apply print exactly one JSON line: {"status","file","message"}.
// --notice prints the session-start upgrade offer (plain text) when the guard
// is outdated and the user has not declined it for this exact file, else
// nothing. --ack records that the user answered the offer: it stores the
// guard's hash in the gitignored .trailhead/label-guard-ack, so the offer
// comes back only if the file changes.
//   status (check):  absent | current | outdated | custom | foreign | skipped
//   status (--apply): installed | upgraded, or the check status when nothing
//                     was written
// Writing only changes the working tree: committing (and pushing, which needs
// the `workflow` token scope) stays with the caller.
// Exit 0 on every normal outcome (including unexpected errors: this must never
// block the caller); exit 2 only on a usage error.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GUARD_REL = path.join('.github', 'workflows', 'trailhead-label-guard.yml');
// Prima riga di ogni versione del guard trailhead (tra le prime 5, trim).
const TRAILHEAD_MARK = '# trailhead label guard:';
const ACK_REL = path.join('.trailhead', 'label-guard-ack');
// Il filtro che deve stare nell'`if:` a livello di job.
const JOB_FILTER = "startsWith(github.event.label.name, 'trailhead:')";

function normalize(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

function isTrailheadGuard(text) {
  return normalize(text).split('\n').slice(0, 5).some((line) => line.trim().startsWith(TRAILHEAD_MARK));
}

// Estrae il testo dell'`if:` diretto di jobs.guard (indentazione 4, prima del
// successivo `steps:`/chiave), incluse le righe di continuazione di `>-`.
// null se jobs.guard non ha un `if:` a livello di job.
function jobGuardIf(text) {
  const lines = normalize(text).split('\n');
  const start = lines.findIndex((l) => /^ {2}guard:\s*$/.test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) return null; // fine del job
    const m = /^ {4}if:\s*(.*)$/.exec(line);
    if (!m) continue;
    const parts = [m[1]];
    for (let j = i + 1; j < lines.length && /^ {6,}\S/.test(lines[j]); j++) parts.push(lines[j].trim());
    return parts.join(' ');
  }
  return null;
}

function hasJobLevelFilter(text) {
  const cond = jobGuardIf(text);
  return cond !== null && cond.includes(JOB_FILTER);
}

function classify({ existingText, templateText }) {
  if (existingText == null) return 'absent';
  if (!isTrailheadGuard(existingText)) return 'foreign';
  if (normalize(existingText) === normalize(templateText)) return 'current';
  return hasJobLevelFilter(existingText) ? 'custom' : 'outdated';
}

const MESSAGES = {
  absent: 'no trailhead label guard in this repo.',
  current: 'the trailhead label guard is already current.',
  outdated: 'the trailhead label guard is outdated: no job-level filter, so every label event starts a billed runner.',
  custom: 'the trailhead label guard has the job-level filter but differs from the template; left untouched.',
  foreign: 'a non-trailhead workflow sits at the label guard path; left untouched.',
  installed: 'installed the trailhead label guard (commit it).',
  upgraded: 'upgraded the trailhead label guard to the current template (commit it).',
};

function writeAtomic(filePath, text, fsMod) {
  const dir = path.dirname(filePath);
  fsMod.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.trailhead-label-guard-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fsMod.writeFileSync(tmpPath, text);
    fsMod.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fsMod.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    throw err;
  }
}

function syncLabelGuard({ repoDir, templateText, apply = false, fs: fsMod = fs }) {
  const file = path.join(repoDir, GUARD_REL);
  const existingText = fsMod.existsSync(file) ? fsMod.readFileSync(file, 'utf8') : null;
  const status = classify({ existingText, templateText });
  if (apply && (status === 'absent' || status === 'outdated')) {
    writeAtomic(file, templateText, fsMod);
    const done = status === 'absent' ? 'installed' : 'upgraded';
    return { status: done, file, message: MESSAGES[done] };
  }
  return { status, file, message: MESSAGES[status] };
}

function sha256(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex');
}

function readGuard(repoDir, fsMod) {
  const file = path.join(repoDir, GUARD_REL);
  return fsMod.existsSync(file) ? fsMod.readFileSync(file, 'utf8') : null;
}

// Registra la risposta all'offerta: hash del guard attuale, cosi' l'offerta
// torna solo se il file cambia. false se non c'e' un guard da ackare.
function ackGuard({ repoDir, fs: fsMod = fs }) {
  const existingText = readGuard(repoDir, fsMod);
  if (existingText == null) return false;
  const file = path.join(repoDir, ACK_REL);
  fsMod.mkdirSync(path.dirname(file), { recursive: true });
  fsMod.writeFileSync(file, sha256(existingText) + '\n');
  return true;
}

function isAcked(repoDir, existingText, fsMod) {
  try {
    return fsMod.readFileSync(path.join(repoDir, ACK_REL), 'utf8').trim() === sha256(existingText);
  } catch {
    return false;
  }
}

// Offerta di sessione (SessionStart o load-first inline): solo per un guard
// trailhead `outdated` non ancora ackato. Sola lettura, mai eccezioni.
function sessionNotice({ repoDir, templateText, scriptPath, fs: fsMod = fs }) {
  try {
    const existingText = readGuard(repoDir, fsMod);
    if (classify({ existingText, templateText }) !== 'outdated') return null;
    if (isAcked(repoDir, existingText, fsMod)) return null;
    const cmd = `node "${scriptPath}" --repo "${repoDir}"`;
    return [
      `trailhead's label guard in this repo (${GUARD_REL}) is outdated: it has no job-level \`if:\`, so every \`issues: labeled\` event starts a GitHub Actions runner billed at least one minute, even for labels it ignores.`,
      'Offer the user, once, without blocking their current request, two choices:',
      `1) upgrade it: run \`${cmd} --apply\`, then commit the file (\`fix: skip trailhead label guard job for irrelevant label events\`) and push (a workflow file needs the \`workflow\` token scope: run \`gh auth refresh -s workflow\` if the push is rejected);`,
      '2) keep it as it is.',
      `This offer reappears every session until answered: once the user has picked either choice, run: ${cmd} --ack`,
    ].join('\n');
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  let repo = null;
  let apply = false;
  let mode = 'sync';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      i++;
      if (i >= argv.length) return { error: 'usage: --repo requires a value' };
      repo = argv[i];
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--notice' || arg === '--ack') {
      if (mode !== 'sync') return { error: 'usage: --notice and --ack are exclusive' };
      mode = arg.slice(2);
    } else {
      return { error: `usage: unknown argument: ${arg}` };
    }
  }
  if (apply && mode !== 'sync') return { error: `usage: --apply cannot be combined with --${mode}` };
  return { repo, apply, mode };
}

function main(argv, { cwd, stdout } = {}) {
  const out = stdout || process.stdout;
  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }
  const repoDir = path.resolve(cwd || process.cwd(), parsed.repo || '.');
  try {
    const templateText = fs.readFileSync(path.join(__dirname, 'trailhead-label-guard.yml'), 'utf8');
    if (parsed.mode === 'notice') {
      const notice = sessionNotice({ repoDir, templateText, scriptPath: __filename });
      if (notice) out.write(notice + '\n');
      return 0;
    }
    if (parsed.mode === 'ack') {
      ackGuard({ repoDir });
      return 0;
    }
    out.write(JSON.stringify(syncLabelGuard({ repoDir, templateText, apply: parsed.apply })) + '\n');
  } catch (err) {
    if (parsed.mode !== 'sync') return 0; // notice/ack: mai rumore
    out.write(JSON.stringify({ status: 'skipped', file: path.join(repoDir, GUARD_REL), message: 'error: ' + (err && err.message ? err.message : String(err)) }) + '\n');
  }
  return 0;
}

module.exports = { normalize, isTrailheadGuard, jobGuardIf, hasJobLevelFilter, classify, syncLabelGuard, sessionNotice, ackGuard, parseArgs, main, GUARD_REL, ACK_REL, JOB_FILTER };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout }));
}
