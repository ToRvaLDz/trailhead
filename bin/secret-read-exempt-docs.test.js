#!/usr/bin/env node
// Test docs per #376: la chiave `secretRead.exempt` e le sue condizioni sono documentate
// nel reference di config e nelle pagine del sito.
// Run: node secret-read-exempt-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const EXPECT = {
  'plugins/trailhead/skills/_shared/configuration-reference.md': ['`secretRead.exempt`', 'Secret-read exemption', 'Project config only', 'not a symlink', 'not gitignored', 'unchanged from the commit', '`rev:path`', 'only statement of the command'],
  'site/src/content/docs/docs/configuration.mdx': ['`secretRead.exempt`', 'Project config only', 'not a symlink', 'not gitignored', 'unchanged from the commit', '`rev:path`', 'only statement of the command'],
  'site/src/content/docs/docs/hooks.md': ['`secretRead.exempt`', 'not a symlink', 'not gitignored', 'unchanged from the commit', '`rev:path`', 'only statement of the command'],
};

for (const [rel, needles] of Object.entries(EXPECT)) {
  const text = read(rel);
  for (const needle of needles) ok(`${rel} names: ${needle}`, text.includes(needle));
  ok(`${rel} has no em-dash`, !text.includes('—'));
}

console.log(`secret-read-exempt-docs.test.js: ${passed} checks passed`);
