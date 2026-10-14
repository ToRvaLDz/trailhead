#!/usr/bin/env node
// Docs test for #242: the skill prose names the gitignored-file copy helper for new
// isolation workspaces and documents the isolation.copy config key.
// Run: node isolation-copy-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// file -> strings it must carry
const EXPECT = {
  'trailhead-work/SKILL.md': ['trailhead-isolation-copy.js --from <main-checkout> --to <working-root>', 'Gitignored files in a new workspace'],
  '_shared/teamwork.md': ['trailhead-isolation-copy.js --from <main-checkout> --to <working-root>', 'Gitignored files in a new workspace', 'isolation.copy', 'before any install'],
  '_shared/configuration-reference.md': ['`isolation.copy`', 'Isolation copy', '.example', '.sample'],
};

for (const [rel, needles] of Object.entries(EXPECT)) {
  const text = read(rel);
  for (const needle of needles) ok(`${rel} names: ${needle}`, text.includes(needle));
  ok(`${rel} has no em-dash`, !text.includes('—'));
}

console.log(`isolation-copy-docs.test.js: ${passed} checks passed`);
