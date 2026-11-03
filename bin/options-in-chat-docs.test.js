#!/usr/bin/env node
// Docs test for #365: options posted on the ticket are the record, never the ask surface.
// The rule is stated once (Grilling technique); call-sites only point at it.
// Run: node options-in-chat-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'plugins', 'trailhead');
const skills = path.join(root, 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const ANCHOR = 'The ask is answerable from the chat alone';
const DEFINITION = `**${ANCHOR}.**`;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

// 1. defined exactly once, in the Grilling technique
const defs = walk(root).filter((f) => fs.readFileSync(f, 'utf8').includes(DEFINITION));
ok('definition appears in exactly one file', defs.length === 1);
ok('definition lives in grilling.md', defs[0] === path.join(skills, '_shared', 'techniques', 'grilling.md'));
const grilling = read('_shared/techniques/grilling.md');
ok('definition appears once', grilling.split(DEFINITION).length === 2);

// 2. the definition carries the normative fragments
const rule = grilling.split('\n').find((l) => l.includes(DEFINITION));
for (const frag of [
  'an `OPTIONS` comment, or any comment',
  'the record, never the ask surface',
  'renders every option asked about in chat',
  'a one-line summary',
  'its trade-off',
  'the recommendation',
  'structured question tool',
  'with no option text',
]) ok(`rule carries: ${frag}`, rule.includes(frag));

// 3. pointers name the rule without restating it
const pointer = (name, line) => {
  ok(`${name} found`, !!line);
  ok(`${name} references the anchor`, line.includes(ANCHOR));
  ok(`${name} does not restate the rule`, !line.includes('never the ask surface'));
};
const engines = read('trailhead-work/references/ticket-engines.md');
pointer('decision Diverge', engines.split('\n').find((l) => l.startsWith('1. **Diverge')));
pointer('decision Converge', engines.split('\n').find((l) => l.startsWith('2. **Converge.**')));
const relay = grilling.split('\n').find((l) => l.startsWith('   - `question`: relay'));
pointer('grilling relay of question', relay);
ok('relay covers a question that only names the options', relay.includes('re-render'));
pointer('chart standalone grill', read('trailhead-chart/SKILL.md').split('\n').find((l) => l.startsWith('Run a standalone **Grilling**')));
const agent = fs.readFileSync(path.join(root, 'agents', 'trailhead-grill.md'), 'utf8');
const q = agent.split('\n').find((l) => l.startsWith('- `question:`'));
pointer('trailhead-grill question field', q);
ok('question field asks label, summary, trade-off', q.includes('label') && q.includes('summary') && q.includes('trade-off'));

// 4. no em-dash
for (const f of [path.join(skills, '_shared/techniques/grilling.md'), path.join(skills, 'trailhead-work/references/ticket-engines.md'),
  path.join(skills, 'trailhead-chart/SKILL.md'), path.join(root, 'agents', 'trailhead-grill.md'), __filename])
  ok(`${path.basename(f)} has no em-dash`, !fs.readFileSync(f, 'utf8').includes(String.fromCharCode(8212)));

console.log(`options-in-chat-docs.test.js: ${passed} checks passed`);
