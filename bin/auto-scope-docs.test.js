#!/usr/bin/env node
// Docs test for #280: auto.md documents the run scope (asked at start, `<n>` skips),
// the queue order rule, the helper, the helper-error stop, and the report split.
// Run: node auto-scope-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.join(__dirname, '..', 'plugins', 'trailhead');
const read = (rel) => fs.readFileSync(path.join(plugin, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const auto = read('skills/trailhead-work/references/auto.md');
for (const needle of [
  '**Pick the run scope.**', 'trailhead-auto-queue.js', "trailhead-auto-queue.js scopes", '`AskUserQuestion`', 'one map, the whiteboard, or everything',
  '`/trailhead:auto <n>`', 'without asking', 'no delegate option', 'before anything is claimed',
  'trailhead-auto-queue.js queue --scope', '--skip', '`next`', 'whiteboard last', 'ascending map number', 'oldest workable ticket first',
  'A helper error stops the run', '`drift`', '`resume`', '--map none',
  'each touched map gets a comment with **only its own part**', 'the whiteboard part stays in chat only', 'a map the run never touched gets no comment',
]) ok(`auto.md names: ${needle}`, auto.includes(needle));

for (const rel of ['skills/trailhead-work/references/auto.md', 'skills/trailhead-work/SKILL.md', 'commands/auto.md', 'templates/trailhead-auto-queue.js']) {
  ok(`${rel} has no em-dash`, !read(rel).includes('—'));
}
for (const rel of ['skills/trailhead-work/SKILL.md', 'commands/auto.md']) {
  ok(`${rel} describes a chosen scope`, /run scope/.test(read(rel)));
  ok(`${rel} no longer says "the map's frontier"`, !read(rel).includes("the map's frontier"));
}
ok('commands/auto.md keeps the [map] hint', read('commands/auto.md').includes('argument-hint: "[map]"'));

console.log(`auto-scope-docs.test.js: ${passed} checks passed`);
