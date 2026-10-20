#!/usr/bin/env node
// Docs test for #281: an autonomous run resolves a ticket through a UAT follow-up
// (found first, reused on resume), writes every record when it arises, and documents
// the hard-stop guarantee. Run: node auto-uat-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.join(__dirname, '..', 'plugins', 'trailhead');
const read = (rel) => fs.readFileSync(path.join(plugin, rel), 'utf8');

const DASH = String.fromCharCode(0x2014);
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const AUTO = 'skills/trailhead-work/references/auto.md';
const ACCEPT = 'skills/_shared/techniques/acceptance-testing.md';
const ENGINES = 'skills/trailhead-work/references/ticket-engines.md';
const SUBSTRATE = 'skills/_shared/substrate-commands.md';

const auto = read(AUTO);
for (const needle of [
  'trailhead-uat-followup.js find', '## Records as it goes', 'never the only record', 'UAT of:', 'trailhead:uat',
  'A helper error is not a "none found"', 'Only an open follow-up is reused', 'closed ones never count',
  'a crash in the instant between the claim and the work-state write', 'leftover work state', 'whose work state has `auto: true`', 'already names the same action', 'its own checklist is already the record', 'trailhead-work-state.js',
  'loses nothing that has arisen', 'UAT follow-ups opened this run',
  'each touched map gets a comment with **only its own part**', 'the whiteboard part stays in chat only', 'a map the run never touched gets no comment',
]) ok(`auto.md names: ${needle}`, auto.includes(needle));
ok('auto.md no longer sets a ticket aside for a human-only UAT step', !auto.includes('leaves that step incomplete and sets the ticket aside'));
ok('auto.md names the needs-you label (#282)', auto.includes('trailhead:needs-you'));

const accept = read(ACCEPT);
for (const needle of ['trailhead-uat-followup.js find', 'autonomous run', 'auto.md', 'opens no duplicate'])
  ok(`acceptance-testing.md names: ${needle}`, accept.includes(needle));

const engines = read(ENGINES);
ok('ticket-engines.md names the autonomous exception in build and bug Resolve', engines.split('Under an autonomous run the guard takes option (b) itself').length - 1 >= 2);

const substrate = read(SUBSTRATE);
for (const needle of ['trailhead-uat-followup.js find --parent <n> --repo <owner/name>', '"reuse"', 'paginated GraphQL `repository.issues` query', 'lagging search index'])
  ok(`substrate-commands.md names: ${needle}`, substrate.includes(needle));

for (const rel of [AUTO, ACCEPT, ENGINES, SUBSTRATE, 'templates/trailhead-uat-followup.js', 'hooks/lib/uat-followup.test.js'])
  ok(`${rel} has no em-dash`, !read(rel).includes(DASH));
ok('this test file has no em-dash', !fs.readFileSync(__filename, 'utf8').includes(DASH));

console.log(`auto-uat-docs.test.js: ${passed} checks passed`);
