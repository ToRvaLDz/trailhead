#!/usr/bin/env node
// Docs test for #244: the ticket-start scope confirm is skipped on a ticket this session
// already shaped. The rule is stated once (Work the map step 3); the quick bullet and the
// choices table only point at it.
// Run: node scope-confirm-skip-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const ANCHOR = 'Skip the confirm on a ticket this session already shaped';
const DEFINITION = `**${ANCHOR}.**`;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

// 1. the bold definition exists exactly once, in trailhead-work/SKILL.md
const defs = walk(skills).filter((f) => fs.readFileSync(f, 'utf8').includes(DEFINITION));
ok('definition appears in exactly one file', defs.length === 1);
ok('definition lives in trailhead-work/SKILL.md', defs[0] === path.join(skills, 'trailhead-work', 'SKILL.md'));
const work = read('trailhead-work/SKILL.md');
ok('definition appears once in SKILL.md', work.split(DEFINITION).length === 2);

// 2. step 3 carries the normative fragments
const lines = work.split('\n');
const s = lines.findIndex((l) => l.startsWith('3. **Brief the ticket and confirm scope'));
const e = lines.findIndex((l, i) => i > s && l.startsWith('4. '));
ok('step 3 found', s >= 0 && e > s);
const step3 = lines.slice(s, e).join('\n');
for (const frag of [
  DEFINITION,
  "from the user's own request for it",
  'a Grilling round on this ticket concluded',
  'created in bulk',
  'earlier session',
  '/clear',
  'resume',
  'one-line',
  'never inferred from tracker metadata',
]) ok(`step 3 carries: ${frag}`, step3.includes(frag));

// 3. the quick bullet only points at the rule
const quick = lines.find((l) => l.startsWith('- **Briefs and confirms scope first'));
ok('quick bullet found', !!quick);
ok('quick bullet references the anchor', quick.includes(ANCHOR));
ok('quick bullet does not restate bulk exclusion', !quick.includes('created in bulk'));
ok('quick bullet does not restate grill trigger', !quick.includes('a Grilling round on this ticket concluded'));

// 4. the choices row only points at the rule
const row = read('_shared/choices.md').split('\n').find((l) => l.startsWith('| Ticket-start scope confirm'));
ok('choices row found', !!row);
ok('choices row references the anchor', row.includes(ANCHOR));
ok('choices row does not restate bulk exclusion', !row.includes('created in bulk'));

// 5. no em-dash in the touched files
for (const rel of ['trailhead-work/SKILL.md', '_shared/choices.md'])
  ok(`${rel} has no em-dash`, !read(rel).includes('\u2014'));
ok('this test has no em-dash', !fs.readFileSync(__filename, 'utf8').includes('\u2014'));

console.log(`scope-confirm-skip-docs.test.js: ${passed} checks passed`);
