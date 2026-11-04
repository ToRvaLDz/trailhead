#!/usr/bin/env node
// Docs test for #358: in grilling a plain "yes" always accepts the recommended answer.
// The rule is defined once (Grilling technique); the grill return contract states it for the agent.
// Run: node yes-accepts-recommended-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const plugin = path.join(repo, 'plugins', 'trailhead');
const read = (...rel) => fs.readFileSync(path.join(...rel), 'utf8');
const line = (text, start) => text.split('\n').find((l) => l.startsWith(start));

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const DEFINITION = '**A yes accepts the recommendation.**';
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

// 1. defined exactly once, in the Grilling technique
const techniquePath = path.join(plugin, 'skills', '_shared', 'techniques', 'grilling.md');
const defs = walk(plugin).filter((f) => read(f).includes(DEFINITION));
ok('definition appears in exactly one file', defs.length === 1);
ok('definition lives in grilling.md', defs[0] === techniquePath);

// 2. the definition carries the normative fragments, on the one-question bullet
const technique = read(techniquePath);
const rule = line(technique, '- **One question at a time, with your pick.**');
ok('rule sits on the one-question bullet', rule.includes(DEFINITION));
for (const frag of [
  'a plain "yes" accepts your pick',
  'never an open "should we A or B?" followed by a recommendation',
  'exactly one meaning',
  'A play-back',
]) ok(`rule carries: ${frag}`, rule.includes(frag));

// 3. the relay never rewords the question out of the rule
const relay = line(technique, '   - `question`: relay');
ok('relay names the rule', relay.includes('**A yes accepts the recommendation**'));

// 4. the return contract states it, in the source block and in the synced agent
for (const [name, text] of [
  ['agent-blocks.md', read(repo, 'scripts', 'agent-blocks.md')],
  ['trailhead-grill.md', read(plugin, 'agents', 'trailhead-grill.md')],
]) {
  const q = line(text, '- `question:` the one numbered question');
  const r = line(text, '- `recommended:` your pick');
  ok(`${name}: question is worded so a yes accepts the pick`, q.includes('a plain "yes" accepts `recommended:`'));
  ok(`${name}: question bans the open form`, q.includes('never an open "should we A or B?"'));
  ok(`${name}: recommended is what a yes accepts`, r.includes('what a plain "yes" accepts'));
}

console.log(`yes-accepts-recommended-docs: ${passed} assertions passed`);
