#!/usr/bin/env node
// Docs test for #332: capture.md documents the scripted capture helper (CLI, statuses,
// exit codes, trust, idea as fog, dedupe, dashboard). Plain asserts, no framework.
// Run: node bin/capture-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'plugins', 'trailhead', 'skills', 'trailhead-capture', 'references', 'capture.md'), 'utf8');
const start = doc.indexOf('## Scripted capture for automations');
const section = start < 0 ? '' : doc.slice(start);
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

ok('capture.md has the scripted capture section', section !== '');
ok('names the helper', section.includes('trailhead-capture.js'));
for (const flag of ['--type', '--title', '--body-file', '--repo', '--map', '--of', '--trigger', '--unverified', '--dedupe-key', '--no-dashboard']) {
  ok(`names ${flag}`, section.includes(flag));
}
for (const status of ['created', 'existing', 'partial', 'error', 'usage']) {
  ok(`documents status ${status}`, section.includes(`"status":"${status}"`));
}
ok('documents exit codes 0, 1, 2 and 3', ['exit 0', 'exit 1', 'exit 2', 'exit 3'].every((c) => section.includes(c)));
ok('partial names prune', /partial[^]*\/trailhead:prune/.test(section));
ok('trust: allowlist is the repo variable, not the local env', section.includes('TRAILHEAD_LABEL_ALLOWLIST') && /never consults its local environment/.test(section));
ok('trust: installation tokens are verified post-create', section.includes('github-actions[bot]'));
ok('idea is parked fog', /`idea` is parked fog/.test(section) && section.includes('`trailhead:fog`'));
ok('dedupe: marker, cap fallback and the lag residual', section.includes('trailhead-dedupe') && section.includes('1000-result cap') && /search-index lag/.test(section));
ok('dashboard rule: whiteboard only, update-only', /whiteboard ticket refreshes the dashboard/.test(section) && section.includes('--update-only'));
ok('no em-dash', !doc.includes(String.fromCharCode(0x2014)));
console.log(`capture-docs.test.js: ${passed} checks passed`);
