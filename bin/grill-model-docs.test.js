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

// --- Parte B: grilling.md "Who runs a round" e techniques.md ---------------------------
{
  const grilling = read('_shared/techniques/grilling.md');
  const techniques = read('_shared/techniques.md');
  const at = grilling.indexOf('\n## Who runs a round');
  ok('B: grilling.md has a Who runs a round section', at !== -1);
  const sec = at === -1 ? '' : grilling.slice(at);
  const has = (...needles) => needles.every((n) => sec.includes(n));
  ok('B: the route call, with --session-effort and unknown',
    has('model-route.js grill --session', '--session-effort', 'unknown', '--no-subagents', '--host codex'));
  ok('B: the helper is found with the same two-path lookup as model-defaults-review.js',
    has('../../hooks/lib/', '../trailhead/hooks/lib/', 'model-defaults-review.js'));
  ok('B: use its agent and alias verbatim', has('use its `agent` and `alias` verbatim'));
  ok('B: route inline with the suggest line', has('`route: inline`', '`suggest`', 'suggesting the user switch the session'));
  ok('B: an unregistered agent runs inline', has('not registered', 'inline'));
  ok('B: the report is checked with --technique grill', has('--technique grill'));
  ok('B: the relay never answers on the user\'s behalf', has('relay', 'Never answer on the user\'s behalf', 'never proceed on silence'));
  ok('B: re-dispatch with the full state', has('re-dispatch with the full state'));
  ok('B: the orchestrator holds the review cap', has('The orchestrator caps reviews at two', 'accepted risk'));
  ok('B: the apply/amend/keep menu is the orchestrator\'s', has('apply', 'amend', 'keep', 'AskUserQuestion'));
  ok('B: the family-not-version note', has('the family of the resolved id, not its exact version'));
  ok('B: an inline round writes no report', has('An inline round writes no report'));
  ok('B: Codex semantics', has('unset `models.codex.grill` inherits the session model', 'equal to the session model'));
  ok('B: the protocol bullets above stay the agent\'s protocol', grilling.indexOf('Holistic review before the final confirmation') < at);

  const dispatch = techniques.split('\n')[4] || '';
  ok('B: techniques.md dispatch list maps Grilling to trailhead-grill', /Grilling → `trailhead-grill`/.test(dispatch));
  ok('B: techniques.md read-only list includes trailhead-grill', /\*\*read-only\*\*[^)]*`trailhead-grill`/.test(dispatch));
  const row = techniques.split('\n').find((l) => l.startsWith('| **Grilling** |')) || '';
  ok('B: the Grilling index row names models.grill', row.includes('`models.grill`'));
}

console.log(`grill-model-docs.test.js: ${passed} checks passed`);
