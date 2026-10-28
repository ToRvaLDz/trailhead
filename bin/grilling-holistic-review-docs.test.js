#!/usr/bin/env node
// Docs test for #301: every grilling close runs a holistic review pass before the final
// confirmation. The rule is stated once (Grilling technique); call-sites only point at it.
// Run: node grilling-holistic-review-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const ANCHOR = 'Holistic review before the final confirmation';
const DEFINITION = `**${ANCHOR}.**`;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

// 1. the bold definition exists exactly once, in the Grilling technique
const defs = walk(skills).filter((f) => fs.readFileSync(f, 'utf8').includes(DEFINITION));
ok('definition appears in exactly one file', defs.length === 1);
ok('definition lives in grilling.md', defs[0] === path.join(skills, '_shared', 'techniques', 'grilling.md'));
const grilling = read('_shared/techniques/grilling.md');
ok('definition appears once', grilling.split(DEFINITION).length === 2);

// 2. the definition bullet carries the normative fragments
const lines = grilling.split('\n');
const rule = lines.find((l) => l.includes(DEFINITION));
for (const frag of [
  'Once the frontier is empty and before the final confirmation',
  'as a whole',
  'against each other and against the destination',
  'proposed amendments',
  'non-working combinations',
  'contradictions, gaps, choices that break each other or the destination',
  'by question number',
  'say so in one line and go straight to the confirmation',
  'Every non-working combination carries its fix',
  'say why in one line and name where it goes',
  'Accepting a combination as a risk is never the proposed fix',
  'apply, amend or keep',
  'apply (the first option, recommended) applies every proposed amendment and fix',
  'keep leaves the choices as they were',
  'consciously accepted risk',
  'reopens that branch',
  'the review runs again on the new set',
  're-confirmed in one play-back',
  'at most once more',
  'Only then is the final set played back, confirmed and recorded',
  '`AskUserQuestion` menu',
  'without the delegate option',
]) ok(`rule carries: ${frag}`, rule.includes(frag));

// 3. the Stop bullet is followed by the review
const stop = lines.find((l) => l.startsWith('- **Stop only when the frontier is empty'));
ok('stop bullet found', !!stop);
ok('stop bullet references the anchor', stop.includes(ANCHOR));
ok('stop bullet scopes the hold to the final set', stop.includes('the final set is not confirmed or recorded before it has run'));

// 4. call-sites only point at the rule
const pointer = (name, text, startsWith) => {
  const l = text.split('\n').find((x) => x.startsWith(startsWith));
  ok(`${name} found`, !!l);
  ok(`${name} references the anchor`, l.includes(ANCHOR));
  ok(`${name} does not restate the rule`, !l.includes('accepted risk') && !l.includes('keep leaves'));
};
pointer('chart SKILL standalone grill', read('trailhead-chart/SKILL.md'), 'Run a standalone **Grilling**');
const engines = read('trailhead-work/references/ticket-engines.md');
pointer('decision Converge', engines, '2. **Converge.**');
pointer('build Discuss', engines, '1. **Discuss**');
ok('build Discuss records the set after the review', engines.split('\n').find((l) => l.startsWith('1. **Discuss**')).includes('after the review'));
const charting = read('trailhead-chart/references/charting.md');
pointer('charting Mode 1 step 3', charting, '3. **Create the map**');
pointer('charting Mode 1-bis step 2', charting, '2. **Name the destination of the remaining stretch.**');
pointer('charting Mode 1-bis step 4', charting, '4. **Map the frontier of the remainder**');
ok('charting Mode 1 step 3 covers the destination too', charting.split('\n').find((l) => l.startsWith('3. **Create the map**')).includes('step 1 destination'));
const choices = read('_shared/choices.md');
const row = choices.split('\n').find((l) => l.startsWith('| Grilling holistic review'));
ok('choices row found', !!row);
const cells = row.split('|').map((c) => c.trim());
ok('choices row delegate No', cells[2].startsWith('No'));
ok('choices row defer No', cells[3] === 'No');
const prose = choices.split('\n').find((l) => l.startsWith('**Prose / conversational call-sites'));
ok('prose paragraph references the anchor', prose.includes(ANCHOR));

// 5. no em-dash in the touched files
for (const rel of ['_shared/techniques/grilling.md', '_shared/choices.md', 'trailhead-chart/SKILL.md',
  'trailhead-work/references/ticket-engines.md', 'trailhead-chart/references/charting.md'])
  ok(`${rel} has no em-dash`, !read(rel).includes(String.fromCharCode(8212)));
ok('this test has no em-dash', !fs.readFileSync(__filename, 'utf8').includes(String.fromCharCode(8212)));

console.log(`grilling-holistic-review-docs.test.js: ${passed} checks passed`);
