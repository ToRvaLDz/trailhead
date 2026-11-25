// Rileva se la statusline di trailhead e' quella attiva (completa) su Claude Code.
// "Attiva" = la statusLine effettiva (primo file che definisce la chiave, in
// ordine: <cwd>/.claude/settings.local.json, <cwd>/.claude/settings.json,
// <configDir>/settings.json) ha un command che richiama statusline-trailhead.sh
// senza i flag dei widget a segmento singolo (che non mostrano il flag update).
// Un settings illeggibile o malformato e' saltato. Ogni errore -> false.

'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT = 'statusline-trailhead.sh';
const WIDGET_FLAGS = ['--ticket-only', '--context-only', '--usage-only'];

function readSettings(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

function effectiveStatusLine({ cwd, configDir }) {
  const files = [
    cwd && path.join(cwd, '.claude', 'settings.local.json'),
    cwd && path.join(cwd, '.claude', 'settings.json'),
    path.join(configDir, 'settings.json'),
  ].filter(Boolean);
  for (const f of files) {
    const s = readSettings(f);
    if (s && Object.prototype.hasOwnProperty.call(s, 'statusLine')) return s.statusLine;
  }
  return undefined;
}

function isTrailheadStatuslineActive({ cwd, configDir }) {
  try {
    const sl = effectiveStatusLine({ cwd, configDir });
    const cmd = sl && typeof sl === 'object' ? sl.command : null;
    if (typeof cmd !== 'string' || !cmd.includes(SCRIPT)) return false;
    return !WIDGET_FLAGS.some((f) => cmd.includes(f));
  } catch { return false; }
}

module.exports = { isTrailheadStatuslineActive, effectiveStatusLine };
