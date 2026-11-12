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

// #368: every reviewer call is bounded by the run helper.
ok('plan-review.md: every reviewer call goes through the run subcommand, whatever the launch mode', /Every reviewer call goes through the `run` subcommand, whatever the launch mode[^\n]*trailhead-plan-review-rounds\.js run --output <dir>\/<cli>\.out -- /.test(review));
ok('plan-review.md: the helper bounds the call because the Bash timeout does not apply to a background call', /helper is what bounds[^\n]*`timeout` parameter does not apply to a background call/.test(review));
ok('plan-review.md: a timeout skips overflow and takes the one-retry rule', /- `timeout`:[^\n]*\*\*Do not run `overflow`\*\*[^\n]*one-retry rule/.test(review));
ok('plan-review.md: a second timeout drops the reviewer, recorded with the seconds', /A second timeout \*\*drops\*\*[^\n]*`second timeout`[^\n]*seconds/.test(review));
ok('plan-review.md: failed or error runs overflow then the one-retry rule', /- `failed` or `error`: run `node <templates>\/trailhead-plan-review-rounds\.js overflow/.test(review));
ok('plan-review.md: the helper-fails fallback names no JSON line and excludes a status error line', /helper is missing, exits non-zero with no JSON line \(a helper killed by a signal prints none\), or prints non-JSON output\*\*[^\n]*`status: error` JSON line is not this case[^\n]*`failed`\/`error` branch/.test(review));
ok('plan-review.md: no human prompt on this path, never reported as still running past the bound', /No human prompt anywhere on this path[^\n]*never reported as "still running" past the bound/.test(review));
ok('plan-review.md: a missing run helper falls back to timeout -k 10 600, 124 or 137 meaning timeout', /helper is missing, exits non-zero[^\n]*`timeout -k 10 600 <cmd> < \/dev\/null > <dir>\/<cli>\.out 2>&1`[^\n]*`gtimeout`[^\n]*124 or 137/.test(review));
ok('plan-review.md: with no bound available the reviewer is skipped, recorded', /neither available, skip the reviewer, recording that no bound was available/.test(review));
ok('plan-review.md: the stdin line is not evidence of a stdin hang', /`Reading additional input from stdin\.\.\.` is \*\*not evidence of a stdin hang\*\*/.test(review));
ok('plan-review.md: the synchronous case still goes through run with the tool timeout above the helper deadline', /still goes through `run`[^\n]*`600000`[^\n]*above the helper's deadline/.test(review));
ok('plan-review.md: the raw-shell 0% CPU stuck check is gone', !/0% CPU/.test(review));
const techniques = read('skills/_shared/techniques.md');
ok('techniques.md: the outcome is awaited up to the bound, a stalled plan reviewer ends as a recorded drop', /the outcome always awaited \(up to its bound[^\n]*stalled reviewer ends as a dropped reviewer, recorded in `PLAN-REVIEW`, never an open wait/.test(techniques));

const root = path.resolve(__dirname, '..');
const site = fs.readFileSync(path.join(root, 'site', 'src', 'content', 'docs', 'docs', 'configuration.mdx'), 'utf8');
for (const [name, text] of [['configuration.mdx', site]]) {
  ok(`${name}: has the plan_review.context row`, /^\| `plan_review\.context` \|/m.test(text));
}

for (const [name, text] of [['plan-review.md', review], ['configuration-reference.md', config], ['techniques.md', techniques]]) {
  ok(`${name}: no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}
console.log(`plan-review-budget-docs.test.js: ${passed} checks passed`);
