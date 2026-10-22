#!/usr/bin/env node
// Docs test for #286: under `git: main` the autonomous run merges a verified slot branch
// into the local trunk and unblocks its dependents. Plain asserts, no framework.
// Run: node bin/auto-merge-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.resolve(__dirname, '..', 'plugins', 'trailhead');
const auto = fs.readFileSync(path.join(plugin, 'skills/trailhead-work/references/auto.md'), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

ok('auto.md: integration under git: main replaces the held rule', auto.includes('**Integration under `git: main`.**') && !auto.includes('**Integration is held.**'));
ok('auto.md: the stale-base preflight runs before the merge', /Resolve stale-base preflight[\s\S]{0,200}main checkout `--sync`, then the ticket branch `--sync`[\s\S]{0,80}re-review/.test(auto));
ok('auto.md: names the merge helper call', auto.includes('trailhead-auto-merge.js merge --repo <main-checkout> --ticket <n>'));
ok('auto.md: merges are one at a time, never a push', /one merge at a time/.test(auto) && /never a push/.test(auto));
ok('auto.md: merged / already-merged resolves, unblocks, removes, frees the slot', /`merged` or `already-merged`[^\n]*resolution comment[^\n]*close the ticket[^\n]*Decisions so far/.test(auto) && /trailhead-auto-merge\.js remove --repo <main-checkout> --ticket <n>/.test(auto) && /free the slot/.test(auto));
ok('auto.md: unblocks dependents with the helper', auto.includes('trailhead-unblock.js --issue <n> --repo <owner/name>'));
ok('auto.md: dependents open their slot at the new trunk SHA', /open their slot at the new trunk SHA/.test(auto));
ok('auto.md: a conflict stays separate, is parked and recorded, dependents stay blocked', /`conflict`[^\n]*stays \*\*separate\*\*/.test(auto) && /conflicting files/.test(auto) && /unmerged list/.test(auto) && /dependents stay blocked/.test(auto));
ok('auto.md: the other statuses park needs-you naming the status', /`dirty`, `not-on-trunk`, `slot-dirty`, `in-progress` and `merge-failed`: park the ticket needs-you/.test(auto) && !/`not-merged`: park/.test(auto));
ok('auto.md: a foreign marker never blocks the merge', !/marker-mismatch/.test(auto) && /never blocks it[^)]*--no-verify[^)]*only when the marker names another ticket/.test(auto));
ok('auto.md: error hands back at once with no further merge', /`error`: hand back at once, with no further merge/.test(auto));
ok('auto.md: other slots are never rebased mid-step', /Other in-flight slots are never rebased mid-step/.test(auto) && /strictly ahead of `origin`/.test(auto));
ok('auto.md: a remove failure is a cleanup error, not a park', /`remove` failure after the close is a cleanup error, not a park/.test(auto) && /other than `removed` \(`error`, `not-merged`, `kept`\)[^.]*never park or reopen it/.test(auto) && /free the slot, list the workspace and the branch in the run-end summary/.test(auto));
ok('auto.md: git: pr and clone slots stay held', /Integration stays held under `git: pr`, and for a clone slot/.test(auto) && /gitlink is a rail action|publishing a gitlink is a rail action/.test(auto));
ok('auto.md: a local merge is not rail-tripping, the push stays the human\'s', /local merge of a verified slot branch into the trunk is not rail-tripping/.test(auto) && /the push stays the human's/.test(auto));
ok('auto.md: resume runs recover first, aborted retried, foreign handed back', /trailhead-auto-merge\.js recover --repo <main-checkout>/.test(auto) && /`aborted`[^.]*merge is retried/.test(auto) && /`foreign`[^.]*hands the run back without touching it/.test(auto));
ok('auto.md: a resolve-step slot ticket is re-driven idempotently', /work state step is `resolve`\*\* is re-driven through Resolve idempotently/.test(auto) && /already-merged/.test(auto) && /resolution comment is posted only if none exists/.test(auto));
ok('auto.md: run-end summary names merged, unmerged with files, trunk ahead of origin', /\*\*what merged\*\*/.test(auto) && /left unmerged/.test(auto) && /ahead of `origin` by N commits/.test(auto));
ok('auto.md: no em-dash', !auto.includes(String.fromCharCode(0x2014)));
console.log(`auto-merge-docs.test.js: ${passed} checks passed`);
