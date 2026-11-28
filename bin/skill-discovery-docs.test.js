#!/usr/bin/env node
// Docs test for #426: the skills.search key row and note, the Skill discovery setup step
// (before Statusline) and the Codex adapter line. Run: node skill-discovery-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { codexSkillAdapterHeader } = require('./lib/codex-projection.js');

const root = path.join(__dirname, '..');
const ref = fs.readFileSync(path.join(root, 'plugins', 'trailhead', 'skills', '_shared', 'configuration-reference.md'), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

ok('key table row', /\| `skills\.search` \| \*\*`auto`\*\* \\\| `off` \|/.test(ref));
ok('note paragraph', ref.includes('**skills.search.**'));
for (const needle of [
  'trailhead-skill-discovery.js',
  '--host-search yes',
  'npx --no skills',
  '.trailhead/skills-declined.json',
  'never blocks the work',
  'only when it is already installed',
]) ok(`note carries: ${needle}`, ref.includes(needle));

const skillStep = ref.indexOf('10. **🔎 Skill discovery**');
const statusStep = ref.indexOf('11. **📊 Statusline**');
ok('setup step Skill discovery exists', skillStep !== -1);
ok('Statusline renumbered to 11 and comes after', statusStep > skillStep);
ok('no stale step 10 Statusline', !ref.includes('10. **📊 Statusline**'));
ok('setup step offers Auto and Off', /🤖 Auto/.test(ref.slice(skillStep, statusStep)) && /🔕 Off/.test(ref.slice(skillStep, statusStep)));
ok('reference has no em-dash', !ref.includes('\u2014'));

const header = codexSkillAdapterHeader();
ok('Codex adapter section I', header.includes('## I. Skill discovery'));
ok('Codex adapter passes --host-search no', header.includes('--host-search no'));

console.log(`skill-discovery-docs.test.js: ${passed} checks passed`);
