#!/usr/bin/env node
// Docs test for #253: the skill prose names the Resolve bookkeeping helpers as the
// default path (trailhead-issue-body.js, trailhead-dashboard.js, and the one `clear`
// that also removes the session-ticket marker), while keeping the by-hand fallback.
// Run: node resolve-helpers-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// file -> strings it must carry
const EXPECT = {
  '_shared/substrate.md': ['trailhead-issue-body.js', 'trailhead-dashboard.js', 'when a helper is missing'],
  '_shared/substrate-commands.md': ['trailhead-issue-body.js append --issue <map> --section "Decisions so far"', 'trailhead-dashboard.js', '--set-last-audit', 'fully generated'],
  'trailhead-work/references/ticket-engines.md': ['trailhead-issue-body.js append --issue <map> --section "Decisions so far"', 'trailhead-dashboard.js', 'trailhead-work-state.js clear --repo <working-root>'],
  'trailhead-work/SKILL.md': ['trailhead-issue-body.js append --issue <map> --section "Decisions so far"', 'trailhead-dashboard.js', 'trailhead-work-state.js clear --repo <working-root>',
    'trailhead-issue-body.js remove --issue <map> --section "Not yet specified" --match "<unique text of the entry>"'],
  '_shared/session-handoff.md': ['trailhead-work-state.js clear --repo <working-root>', 'removes both'],
  '_shared/teamwork.md': ['trailhead-issue-body.js append --issue <map> --section "Decisions so far"', 'sessionTicket', 'when the helper is missing'],
  'trailhead-view/SKILL.md': ['trailhead-dashboard.js', '--dry-run'],
  'trailhead-manage/references/auditing.md': ['trailhead-dashboard.js --set-last-audit'],
  '_shared/configuration-reference.md': ['trailhead-issue-body.js replace --issue <conventions> --section :preamble'],
};

for (const [rel, needles] of Object.entries(EXPECT)) {
  const text = read(rel);
  for (const needle of needles) ok(`${rel} names: ${needle}`, text.includes(needle));
  ok(`${rel} has no em-dash`, !text.includes('—'));
}

console.log(`resolve-helpers-docs.test.js: ${passed} checks passed`);
