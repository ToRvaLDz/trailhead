#!/usr/bin/env node
// Docs test for #295: the autonomous run persists its start-up choices and lists in
// .trailhead/auto-run.json so it survives a compaction. Plain asserts, no framework.
// Run: node bin/auto-run-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.resolve(__dirname, '..', 'plugins', 'trailhead');
const auto = fs.readFileSync(path.join(plugin, 'skills/trailhead-work/references/auto.md'), 'utf8');
const gitignore = fs.readFileSync(path.resolve(__dirname, '..', '.gitignore'), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

ok('auto.md: read runs at engagement, before the asks', /trailhead-auto-run\.js read --repo <main-checkout>[^\n]*before (any|the) ask/i.test(auto));
ok('auto.md: found with sameSession true is reused without asking and announced', /`sameSession: true`[^\n]*reuse it without asking/.test(auto) && /announced in one chat line naming the reused scope, slots and review/.test(auto));
ok('auto.md: another session\'s record asks once to resume or start fresh', /`sameSession: false`[^\n]*run still active elsewhere[^\n]*ask once/.test(auto) && /no delegate option/.test(auto) && /replaces the three asks/.test(auto));
ok('auto.md: resume reloads the skip and unmerged lists', /reload the record's skip and unmerged lists/.test(auto));
ok('auto.md: an explicit <n> that differs starts fresh with start --replace', /explicit `\/trailhead:auto <n>`[^\n]*differs[^\n]*starts a fresh run[^\n]*start --replace/.test(auto));
ok('auto.md: corrupt is reported then start --replace', /`corrupt`[^\n]*start --replace[^\n]*plain `start` would answer `exists`/.test(auto));
ok('auto.md: start runs after the last ask and before anything is claimed', /trailhead-auto-run\.js start --repo <main-checkout>[^\n]*--scope[^\n]*--slots[^\n]*--review/.test(auto) && /right after the last start-up ask and before anything is claimed/.test(auto));
ok('auto.md: the record is gitignored', auto.includes('.trailhead/auto-run.json') && /\.gitignore/.test(auto) && /^\.trailhead\/auto-run\.json$/m.test(gitignore));
ok('auto.md: every skipped outcome is reported and never blocks', /Any `skipped` result[^\n]*one chat line[^\n]*the run continues/.test(auto) && /skipped `read` is treated as `absent`/.test(auto) && /safety net, not a gate/.test(auto));
ok('auto.md: skip runs on each skip-list add', /trailhead-auto-run\.js skip --repo <main-checkout> --ticket <n>/.test(auto) && /every time a ticket joins the run's skip list/i.test(auto));
ok('auto.md: unmerged is recorded right after the abort, before the tracker call', /trailhead-auto-run\.js unmerged --repo <main-checkout> --ticket <n> --branch trailhead\/t<n>[^\n]*--file/.test(auto) && /before any tracker call/.test(auto));
ok('auto.md: unmerged again with --merge-ticket after the add succeeds', /--merge-ticket <n>/.test(auto) && /after the merge-ticket `add` succeeds/.test(auto));
ok('auto.md: a crash or failed add still leaves the branch on the persisted list', /still leaves the branch on the persisted unmerged list/.test(auto));
const parallel = auto.slice(auto.indexOf('## Parallel slots'), auto.indexOf('## Parking a ticket'));
const outside = auto.replace(parallel, '');
ok('auto.md: a general compaction rule sits outside Parallel slots and holds whatever the slot count and sameSession', /After a context compaction mid-run[^\n]*whatever the slot count[^\n]*trailhead-auto-run\.js read --repo <main-checkout>[^\n]*whatever `sameSession` says[^\n]*without asking/.test(outside) && /scope, slots, review choice, skip and unmerged lists/.test(outside));
ok('auto.md: the orchestrator knows it is mid-run from its own context', /mid-run from its own context/.test(outside));
ok('auto.md: the sameSession ask applies only at engagement', /`sameSession` ask applies only at engagement/.test(auto) && /fresh `\/trailhead:auto` invocation/.test(auto));
ok('auto.md: no session id host note (Codex)', /`sameSession` is always false on a host with no session id \(Codex\)/.test(auto) && /re-invocation after a crash always gets the resume-or-fresh ask/.test(auto) && /mid-run compaction never does/.test(auto));
ok('auto.md: the slot table bullet points at the general rule', /slot table from `trailhead-auto-slot\.js list`[^\n]*general compaction rule/.test(parallel) && !/trailhead-auto-run\.js read/.test(parallel));
ok('auto.md: run end unites the in-memory lists with the record', /in-memory skip and unmerged lists[^\n]*united with the record's/.test(auto));
ok('auto.md: run end clears the record, then resets the work states', /trailhead-auto-run\.js clear --repo <main-checkout>[^\n]*then[^\n]*--auto false/.test(auto) && /Clearing first means a crash between the two/.test(auto));
ok('auto.md: a host interrupt writes nothing, so Esc leaves the crash signature', !/graceful interrupt clears it too/.test(auto) && !/a graceful interrupt clears the record/.test(auto) && /same on disk as a crash/.test(auto) && /signature of both an Esc and a crash/.test(auto));
ok('auto.md: after Esc the same session reuses the record, a new session is asked again', /Esc[^\n]*reuses the record/.test(auto) && /new session[^\n]*(asked again|resume-or-fresh)/.test(auto));
ok('auto.md: step 2 writes the missing PAUSED checkpoint and label before resuming a crash-signature ticket', /Reconstruct the missing checkpoint/.test(auto) && /reconstructed at resume/.test(auto) && /adds `trailhead:paused` \(after the comment, so a failed comment never leaves a label without a checkpoint\)/.test(auto) && /resumes the ticket through the `resume` engine, which drops the label/.test(auto) && /no second checkpoint/.test(auto));
ok('auto.md: no run-end summary at a host interrupt, the resumed run covers it', /not emitted at the interrupt/.test(auto) && /resumed run's own (run-end )?summary/.test(auto));
ok('auto.md: crash signature and idempotence are stated on the latest checkpoint', /whose latest checkpoint is not a `PAUSED` comment/.test(auto) && /skipped only when the latest checkpoint is already a `PAUSED` comment or the label is present/.test(auto));
ok('auto.md: a slot ticket at the resolve step is exempt from reconstruction', /work state step is `resolve`[^\n]*exempt from (the )?reconstruction/.test(auto));
ok('auto.md: reconstruction happens when the ticket is resumed, not for a waiting extra', /Reconstruction happens when the ticket is actually resumed[^\n]*untouched/.test(auto));
const docs = {
  'README.md': 'README.md',
  'README.it.md': 'README.it.md',
  'workflow.md': 'site/src/content/docs/docs/workflow.md',
  'commands/work.md': 'site/src/content/docs/docs/commands/work.md',
};
const root = path.resolve(__dirname, '..');
for (const [name, rel] of Object.entries(docs)) {
  const t = fs.readFileSync(path.join(root, rel), 'utf8');
  const it = name === 'README.it.md';
  ok(`${name}: no interrupt-time PAUSED checkpoint promise`, !/(Stop\/Esc|Esc or Stop|Esc)[^\n]*(keeps its claim and gets|keeps its claim with|mantiene il claim e riceve)[^\n]*`PAUSED`/.test(t) && !/gets a `PAUSED` checkpoint naming/.test(t));
  ok(`${name}: Esc writes nothing and the next auto writes the missing PAUSED checkpoint`, it
    ? /Esc[^\n]*non scrive nulla[^\n]*stessa traccia di un crash[^\n]*`\/trailhead:auto`[^\n]*checkpoint `PAUSED` mancante[^\n]*workspace e branch/.test(t) && /stessa sessione[^\n]*riusa[^\n]*nuova sessione[^\n]*chiede di nuovo/.test(t)
    : /Esc[^\n]*writes nothing[^\n]*same trace as a crash[^\n]*`\/trailhead:auto`[^\n]*missing `PAUSED` checkpoint[^\n]*workspace and branch/.test(t) && /same session[^\n]*reuses[^\n]*new session[^\n]*asks again/.test(t));
}
ok('auto.md: no em-dash', !auto.includes(String.fromCharCode(0x2014)));
console.log(`auto-run-docs.test.js: ${passed} checks passed`);
