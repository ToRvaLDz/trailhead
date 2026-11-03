#!/usr/bin/env node
// Docs test for #353: plan review skips a reviewer whose prompt exceeds its context.
// Plain asserts, no framework. Run: node bin/plan-review-budget-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.resolve(__dirname, '..', 'plugins', 'trailhead');
const read = (rel) => fs.readFileSync(path.join(plugin, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const review = read('skills/_shared/techniques/plan-review.md');
const config = read('skills/_shared/configuration-reference.md');

ok('plan-review.md: runs the budget call before each reviewer call', /trailhead-plan-review-rounds\.js budget --repo[^\n]*--reviewer[^\n]*--prompt/.test(review));
ok('plan-review.md: names the three decisions arg, file, skip', /`arg`:[\s\S]*`file`:[\s\S]*`skip`:/.test(review));
ok('plan-review.md: file passes the pointer, never the brief as one argument', /`file`:[^\n]*`pointer`[^\n]*never the brief itself as one argument/.test(review));
ok('plan-review.md: notes the E2BIG limit of a single argument', /128 KiB[^\n]*E2BIG/.test(review));
ok('plan-review.md: skip does not invoke the reviewer and records the reason', /`skip`:\s*do not invoke[^\n]*`reason`/.test(review));
ok('plan-review.md: captures stdout and stderr together into one output file', /> <dir>\/<cli>\.out 2>&1/.test(review));
ok('plan-review.md: a shell-tool launch failure is written into the same file', /shell tool itself fails to launch[^\n]*same file/.test(review));
ok('plan-review.md: runs the overflow call on a failed call', /trailhead-plan-review-rounds\.js overflow --output/.test(review));
ok('plan-review.md: overflow true means no retry, recorded as skipped with its reason', /`overflow: true`[^\n]*do not retry[^\n]*skipped[^\n]*`reason`/.test(review));
ok('plan-review.md: the one-retry rule never applies after an overflow', /One retry \(never after a context overflow\)/.test(review));
ok('plan-review.md: PLAN-REVIEW lists every skipped or dropped reviewer with its reason, never silent', /`PLAN-REVIEW`[^\n]*every reviewer skipped or dropped, with its reason[^\n]*budget skip[^\n]*context overflow[^\n]*second timeout[^\n]*hard error[^\n]*never a silent drop/.test(review));
ok('plan-review.md: all reviewers skipped falls back to the no-reviewer rule', /every reviewer ends up skipped[^\n]*no-reviewer-left rule/.test(review));

ok('configuration-reference.md: has the plan_review.context row', /^\| `plan_review\.context` \|/m.test(config));
ok('configuration-reference.md: explains the 65% rule, the estimate and the post-check', /\*\*plan_review\.context\.\*\*[^\n]*ceil\(bytes \/ 3\)[^\n]*65%[^\n]*not a guarantee[^\n]*not retried/.test(config));
ok('configuration-reference.md: documents the per-reviewer merge', /\*\*plan_review\.context\.\*\*[^\n]*merge per reviewer[^\n]*project wins/.test(config));

ok('plan-review.md: the overflow call passes the brief so echoed lines are ignored', /overflow --output <dir>\/<cli>\.out --prompt <brief file>/.test(review));
ok('plan-review.md: a failing budget or overflow helper has a stated fallback', /When `budget` or `overflow` itself fails[^\n]*never guess[^\n]*at most 100 KiB/.test(review));

const root = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeIt = fs.readFileSync(path.join(root, 'README.it.md'), 'utf8');
const site = fs.readFileSync(path.join(root, 'site', 'src', 'content', 'docs', 'docs', 'configuration.mdx'), 'utf8');
for (const [name, text] of [['README.md', readme], ['README.it.md', readmeIt], ['configuration.mdx', site]]) {
  ok(`${name}: has the plan_review.context row`, /^\| `plan_review\.context` \|/m.test(text));
}

for (const [name, text] of [['plan-review.md', review], ['configuration-reference.md', config]]) {
  ok(`${name}: no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}
console.log(`plan-review-budget-docs.test.js: ${passed} checks passed`);
