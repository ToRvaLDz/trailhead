#!/usr/bin/env node
// Docs test per #323: Grilling gira su models.grill / trailhead-grill, con la sessione
// principale come orchestratore HITL. Il protocollo e' scritto una volta (grilling.md);
// i punti d'ingresso lo richiamano soltanto.
// Run: node grill-model-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- Parte A: configuration-reference.md e configuration.md --------------------------
{
  const ref = read('_shared/configuration-reference.md');
  const cfg = read('_shared/configuration.md');
  const lines = ref.split('\n');
  const rowStart = (prefix) => lines.find((l) => l.startsWith(prefix)) || '';
  ok('A: models.{...} key-table row lists grill', /^\| `models\.\{[^}]*\bgrill\b[^}]*\}`/.test(rowStart('| `models.{')));
  ok('A: models.codex.{...} key-table row lists grill', /^\| `models\.codex\.\{[^}]*\bgrill\b[^}]*\}`/.test(rowStart('| `models.codex.{')));
  ok('A: Models bullet for grill', lines.some((l) => /^- `grill`:/.test(l) && l.includes('Grilling')));
  ok('A: subagent bullet maps grill to trailhead-grill and says the session keeps asking the user',
    lines.some((l) => /^- `grill`/.test(l) && l.includes('trailhead-grill') && /session (keeps|still) ask/.test(l)));
  const header = lines.find((l) => l.startsWith('| profile |')) || '';
  ok('A: profile table has a grill column', header.includes('| grill |'));
  const col = (name) => {
    const idx = header.split('|').map((c) => c.trim()).indexOf('grill');
    const row = lines.find((l) => l.startsWith(`| **${name}** |`)) || '';
    return row.split('|').map((c) => c.trim())[idx];
  };
  ok('A: grill column reads High strong, Balanced strong, Low standard',
    col('High') === 'strong' && col('Balanced') === 'strong' && col('Low') === 'standard');
  ok('A: eight keys instead of seven', ref.includes('all eight keys') && ref.includes('its eight model keys') && !/\bseven\b/.test(ref));
  const advanced = lines.filter((l) => l.includes('behind an "Advanced" option') || l.includes('behind Advanced'));
  ok('A: Advanced lists name grill for Claude and Codex', advanced.length === 2 && advanced.every((l) => l.includes('`grill`')));
  const everything = lines.find((l) => l.startsWith('**Everything else runs in the main session')) || '';
  ok('A: Everything else paragraph no longer lists grilling', everything.length > 0 && !/grilling/i.test(everything.split("That's deliberate")[0]));
  ok('A: Codex sentence (unset inherits, profile or pin brings strong, equal pin runs inline)',
    /unset `models\.codex\.grill` inherits the session model/.test(ref) &&
    ref.includes('a profile or a pin brings the strong tier') && ref.includes('equal pin runs inline'));
  ok('A: a spawn gets the family, not the exact version', ref.includes('A dispatched grill is guaranteed the family of the resolved id, not its exact version'));
  ok('A: configuration.md lists grill in the subagent list', /`research`, `review`, `debug`, `verify`, `codebase-map`, `grill`/.test(cfg));
}

console.log(`grill-model-docs.test.js: ${passed} checks passed`);
