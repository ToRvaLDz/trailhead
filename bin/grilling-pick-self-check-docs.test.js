#!/usr/bin/env node
// Docs test: every grilled question's recommended answer is stress-tested once before it is
// offered, and the result is shown with the pick. The rule is stated once (Grilling technique).
// Run: node grilling-pick-self-check-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const DEFINITION = '**Stress-test your pick before offering it.**';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

// 1. la definizione esiste una sola volta, nella tecnica Grilling
const defs = walk(skills).filter((f) => fs.readFileSync(f, 'utf8').includes(DEFINITION));
ok('definition appears in exactly one file', defs.length === 1);
ok('definition lives in grilling.md', defs[0] === path.join(skills, '_shared', 'techniques', 'grilling.md'));
const grilling = read('_shared/techniques/grilling.md');
ok('definition appears once', grilling.split(DEFINITION).length === 2);

// 2. il bullet porta i frammenti normativi
const lines = grilling.split('\n');
const rule = lines.find((l) => l.includes(DEFINITION));
for (const frag of [
  'Before you state a recommended answer',
  'the edge case or failure mode where it breaks',
  'checked against the code rather than assumed',
  'already settled in earlier questions',
  'by question number',
  'holistic review',
  'real holes, not manufactured doubt',
  'One pass, no loop',
  'present only that',
  'Weak point:',
  'still recommended because',
  'conversation language',
  'trivial or already-decided choice',
]) ok(`rule carries: ${frag}`, rule.includes(frag));

// 3. il bullet segue subito "One question at a time, with your pick"
const pickIdx = lines.findIndex((l) => l.startsWith('- **One question at a time, with your pick.**'));
ok('pick bullet found', pickIdx >= 0);
ok('self-check bullet follows the pick bullet', lines[pickIdx + 1] === rule);
ok('pick bullet points at the self-check', lines[pickIdx].includes('stress-tested per the next bullet'));

// 4. niente em-dash
ok('grilling.md has no em-dash', !grilling.includes(String.fromCharCode(8212)));
ok('this test has no em-dash', !fs.readFileSync(__filename, 'utf8').includes(String.fromCharCode(8212)));

console.log(`grilling-pick-self-check-docs.test.js: ${passed} checks passed`);
