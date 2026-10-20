#!/usr/bin/env node
// Docs test for #284: the autonomous run asks the external review rounds at start-up and
// parks a ticket whose plan review does not converge. Plain asserts, no framework.
// Run: node bin/auto-review-rounds-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.resolve(__dirname, '..', 'plugins', 'trailhead');
const read = (rel) => fs.readFileSync(path.join(plugin, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const auto = read('skills/trailhead-work/references/auto.md');
const review = read('skills/_shared/techniques/plan-review.md');
const config = read('skills/_shared/configuration-reference.md');

ok('auto.md has the External review rounds bullet', auto.includes('**External review rounds.**'));
ok('auto.md names the ask call', auto.includes('trailhead-plan-review-rounds.js ask'));
ok('auto.md: skip when plan review is off or no independent reviewer CLI is installed', /`skip`[^.]*plan review off[^.]*no independent reviewer CLI/.test(auto));
ok('auto.md: one AskUserQuestion with the helper options, at most four, config Recommended first', /one `AskUserQuestion`[^.]*`options`[^.]*at most four[^.]*Recommended/.test(auto));
ok('auto.md names the five choices', /as in config, 1, 2, 3, or until convergence/.test(auto));
ok('auto.md: until convergence stops on no progress, hard ceiling 5', /no progress[^.]*hard ceiling 5/.test(auto));
ok('auto.md: numbered list of all five without a structured question tool', /full five as a numbered list/.test(auto));
ok('auto.md: an ask error hands back before any claim', /`error`[^.]*reports it and hands back before any claim/.test(auto));
ok('auto.md: the ask is the human\'s, no delegate, also under <n>', /no delegate[^.]*before any claim/.test(auto) && /also under `\/trailhead:auto <n>`/.test(auto));
ok('auto.md: the choice holds for every build ticket, each slot included', /holds for every `build` ticket of the run[^.]*slot/.test(auto));
ok('auto.md: the wired-separately aside is gone', !/wired separately/.test(auto));
ok('auto.md: names the parking trigger statuses', /`exhausted`[^.]*`no-progress`[^.]*`ceiling`/.test(auto));
ok('auto.md: parks after PLAN and PLAN-REVIEW are posted, quoting each concern\'s full text', /after the `PLAN` and `PLAN-REVIEW` comments are posted/.test(auto) && /full `text`[^.]*`surviving`[^.]*never just (its|the) key/.test(auto));
ok('auto.md: names the round call', auto.includes('trailhead-plan-review-rounds.js round'));

ok('plan-review.md: rounds come from config or the run start-up choice', /`config\.plan_review\.rounds`[^.]*autonomous run[^.]*start-up choice/.test(review));
ok('plan-review.md: calls the round helper and follows its decision', review.includes('trailhead-plan-review-rounds.js round') && /follows its decision/.test(review));
ok('plan-review.md: under an autonomous run the checkpoint is not posed, the ticket is parked', /autonomous run[^.]*checkpoint is not posed[\s\S]{0,400}trailhead-needs-you\.js park/.test(review));
ok('plan-review.md: the park reason lists the surviving blocking concerns', /reason listing the surviving blocking concerns/.test(review));
ok('plan-review.md: interactive behaviour unchanged', /interactive[^.]*unchanged/i.test(review));

ok('configuration-reference.md: plan_review.rounds notes the run ask override', /plan_review\.rounds[^\n]*autonomous run asks at start[^\n]*overrides the key for that run/.test(config));

for (const [name, text] of [['auto.md', auto], ['plan-review.md', review], ['configuration-reference.md', config]]) {
  ok(`${name}: no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}
console.log(`auto-review-rounds-docs.test.js: ${passed} checks passed`);
