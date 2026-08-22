#!/usr/bin/env node
// trailhead update check (SessionStart hook).
// Rileva il canale di installazione, confronta la versione installata con la
// latest della fonte coerente (npm registry per install npm; GitHub per plugin
// e dev-symlink), e scrive il risultato in una cache che la statusline e il
// comando /trailhead:update leggono. Gira in background, throttled, e non deve
// MAI far fallire l'avvio della sessione: ogni errore degrada in silenzio.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'ToRvaLDz/trailhead';
const NPM_PKG = '@marcomigozzi/trailhead';
const THROTTLE_MS = 6 * 60 * 60 * 1000; // ricontrolla al massimo ogni 6h

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function cacheFile() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'trailhead', 'update-check.json');
}
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function clean(v) { return String(v || '').trim().replace(/^v/, ''); }
// confronto semver: 1 se a>b, -1 se a<b, 0 uguali (ignora il pre-release finemente)
function cmp(a, b) {
  const pa = clean(a).split('-')[0].split('.').map(Number);
  const pb = clean(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// --- rileva canale + versione installata ---
function detect() {
  // 0) codex: lo script vive sotto <codexHome>/skills/trailhead/hooks/, un
  // percorso robusto e indipendente dall'env (non serve CODEX_HOME).
  const onCodex = /[\\/]skills[\\/]trailhead[\\/]hooks$/.test(__dirname);
  if (onCodex) {
    const ver = (readFileSafe(path.join(__dirname, '..', 'VERSION')) || '').trim();
    if (SEMVER.test(clean(ver))) {
      return { channel: 'codex', version: clean(ver), where: path.join(__dirname, '..'), host: 'codex' };
    }
  }
  const cfg = configDir();
  // 1) plugin: elencato in installed_plugins.json
  const ip = readJSON(path.join(cfg, 'plugins', 'installed_plugins.json'));
  if (ip && ip.plugins) {
    const key = Object.keys(ip.plugins).find((k) => /^trailhead@/.test(k) || k === 'trailhead');
    if (key) {
      const inst = (ip.plugins[key] || [])[0] || {};
      return { channel: 'plugin', version: clean(inst.version), where: inst.installPath || '' };
    }
  }
  // 2) dev-symlink: skills/trailhead è un symlink al checkout
  const skill = path.join(cfg, 'skills', 'trailhead');
  let st = null;
  try { st = fs.lstatSync(skill); } catch { st = null; }
  if (st && st.isSymbolicLink()) {
    const target = fs.realpathSync(skill); // .../plugins/trailhead/skills/trailhead
    const pj = readJSON(path.join(target, '..', '..', '.claude-plugin', 'plugin.json'));
    const repoRoot = run('git', ['-C', target, 'rev-parse', '--show-toplevel']);
    return { channel: 'dev', version: clean(pj && pj.version), where: repoRoot || target };
  }
  // 3) npm-copy: la versione la scrive l'installer in trailhead/VERSION
  const ver = (readFileSafe(path.join(cfg, 'trailhead', 'VERSION')) || '').trim();
  return { channel: 'npm', version: clean(ver), where: cfg };
}
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// --- latest dalla fonte coerente col canale ---
function latestNpm() {
  const v = run('npm', ['view', NPM_PKG, 'version']);
  return SEMVER.test(clean(v)) ? clean(v) : '';
}
function latestGitHub() {
  // preferisci l'ultima release taggata; fallback: la versione del plugin.json sul branch default
  const tag = run('gh', ['api', `repos/${REPO}/releases/latest`, '-q', '.tag_name']);
  if (SEMVER.test(clean(tag))) return clean(tag);
  const raw = run('gh', ['api', `repos/${REPO}/contents/plugins/trailhead/.claude-plugin/plugin.json`, '-q', '.content']);
  if (raw) {
    try {
      const pj = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      if (SEMVER.test(clean(pj.version))) return clean(pj.version);
    } catch { /* ignore */ }
  }
  return '';
}

function main() {
  const out = cacheFile();
  const info = detect();
  if (!SEMVER.test(clean(info.version))) return; // versione installata sconosciuta: non azzardare

  // throttle: se la cache è fresca (<6h) riusa quel verdetto senza richiamare la rete
  let prev = null;
  try { prev = readJSON(out); } catch { prev = null; }

  let verdict;
  if (prev && prev.checkedAt && Date.now() - prev.checkedAt < THROTTLE_MS) {
    verdict = prev;
  } else {
    const latest = (info.channel === 'npm' || info.channel === 'codex') ? latestNpm() : latestGitHub();
    if (!SEMVER.test(clean(latest))) return; // rete/fonte non disponibile: lascia la cache com'è

    verdict = {
      channel: info.channel,
      installed: clean(info.version),
      latest: clean(latest),
      updateAvailable: cmp(latest, info.version) > 0,
      where: info.where || '',
      checkedAt: Date.now(),
    };
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out + '.tmp', JSON.stringify(verdict));
      fs.renameSync(out + '.tmp', out);
    } catch { /* ignore */ }
  }

  // Codex non ha una statusline: l'hook stesso deve segnalare l'update
  // disponibile via additionalContext, su OGNI sessione (non solo quando la
  // finestra di throttle si riapre). Su Claude (info.host è undefined) non
  // scrive mai su stdout: comportamento invariato.
  if (info.host === 'codex' && verdict && verdict.updateAvailable === true && SEMVER.test(clean(verdict.latest))) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Heads up: trailhead ${verdict.latest} is available (you have ${verdict.installed}). Run $trailhead update to install it.`,
      },
    }));
  }
}

// esegui in background: non blocca l'avvio della sessione.
// L'hook stesso ritorna subito; il lavoro (rete) è dentro main() con timeout brevi.
try { main(); } catch { /* mai far fallire SessionStart */ }
