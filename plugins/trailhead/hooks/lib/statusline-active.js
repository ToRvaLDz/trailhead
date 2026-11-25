// Detects whether trailhead's statusline is the active (full) one on Claude Code.
// "Active" = the effective statusLine (first file that defines the key, in
// order: <projectDir>/.claude/settings.local.json, <projectDir>/.claude/settings.json,
// <configDir>/settings.json) has a command that calls statusline-trailhead.sh
// without the single-segment widget flags (those never show the update flag).
// An unreadable or malformed settings file is skipped. Any error -> false.

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

function effectiveStatusLine({ projectDir, configDir }) {
  const files = [
    projectDir && path.join(projectDir, '.claude', 'settings.local.json'),
    projectDir && path.join(projectDir, '.claude', 'settings.json'),
    path.join(configDir, 'settings.json'),
  ].filter(Boolean);
  for (const f of files) {
    const s = readSettings(f);
    if (s && Object.prototype.hasOwnProperty.call(s, 'statusLine')) return s.statusLine;
  }
  return undefined;
}

function isTrailheadStatuslineActive({ projectDir, configDir }) {
  try {
    const sl = effectiveStatusLine({ projectDir, configDir });
    const cmd = sl && typeof sl === 'object' ? sl.command : null;
    if (typeof cmd !== 'string' || !cmd.includes(SCRIPT)) return false;
    return !WIDGET_FLAGS.some((f) => cmd.includes(f));
  } catch { return false; }
}

module.exports = { isTrailheadStatuslineActive, effectiveStatusLine };
