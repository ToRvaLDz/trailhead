#!/usr/bin/env node
// Docs test for #283: the autonomous run asks for parallel slots and works each slot
// ticket in its own worktree. Plain asserts, no framework. Run: node bin/auto-slots-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.resolve(__dirname, '..', 'plugins', 'trailhead');
const read = (rel) => fs.readFileSync(path.join(plugin, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const auto = read('skills/trailhead-work/references/auto.md');
const work = read('skills/trailhead-work/SKILL.md');
const team = read('skills/_shared/teamwork.md');

ok('auto.md asks the slot count, 1 to 4, proposed 2', /Parallel slots: 1, 2, 3 or 4/.test(auto) && /\*\*2 proposed\*\*/.test(auto) && auto.includes('AskUserQuestion'));
ok('auto.md asks the slot count even with <n>', /`\/trailhead:auto <n>` skips only the scope ask: it \*\*still asks the slot count\*\*/.test(auto));
ok('auto.md slot ask is the human\'s, no delegate', /there is no delegate option, and it is asked before anything is claimed/.test(auto));
ok('auto.md names the open helper call with --base', auto.includes('trailhead-auto-slot.js open --repo <main-checkout> --ticket <n> --base <sha>'));
ok('auto.md names the list helper call', auto.includes('trailhead-auto-slot.js list --repo <main-checkout>'));
ok('auto.md handles clone-required', auto.includes('clone-required') && auto.includes('checkout -b trailhead/t<n> <base>'));
ok('auto.md writes sessionless slot work state', auto.includes('env -u CLAUDE_CODE_SESSION_ID node <templates>/trailhead-work-state.js set --repo <workspace>'));
ok('auto.md resumes a ticket in its own workspace', /resumed \*\*in that workspace\*\*, whatever the slot count/.test(auto) && auto.includes('left alone'));
ok('auto.md: a slot never writes the active-map marker', /A slot never writes the `\.trailhead\/active-map` marker/.test(auto) && /every map-scoped call[^.]*names the map explicitly/.test(auto));
ok('auto.md: isolation override above 1 slot, none and auto included', /Above 1 slot[^.]*a worktree whatever `isolation:` says\*\* \(`none` and `auto` included\)/.test(auto));
ok('auto.md: background dispatch, nothing inline', auto.includes('background subagent') && auto.includes('nothing runs inline'));
ok('auto.md: in-flight tickets join --skip when filling a slot', /in-flight ticket/.test(auto) && /--skip <csv>` with the run's skip list \*\*plus every in-flight ticket\*\*/.test(auto));
ok('auto.md: integration held as needs-you, branch and workspace kept', /parked needs-you for integration/.test(auto) && /\*\*kept\*\*/.test(auto));
ok('auto.md: interruption and run end per workspace', /every in-flight slot ticket\*\* gets its `PAUSED` checkpoint/.test(auto) && auto.includes('each remaining workspace'));

ok('auto.md: every set on a slot workspace is sessionless', /every `set` on a slot workspace[^.]*`env -u CLAUDE_CODE_SESSION_ID`/.test(auto));
ok('auto.md: the run-end reset on a workspace is sessionless too', /env -u CLAUDE_CODE_SESSION_ID node <templates>\/trailhead-work-state\.js set --repo <workspace> --auto false/.test(auto));
ok('auto.md: open statuses explained (reentered clone as is, stale worktree parks needs-you)', /`reentered` clone is used as is/.test(auto) && /stale worktree[\s\S]{0,400}park it needs-you/.test(auto) && auto.includes('git worktree prune'));

for (const [name, text] of [['teamwork.md', team], ['SKILL.md', work]]) {
  ok(`${name}: no longer says the run is always the current checkout`, !/sequential work, no concurrency|works tickets sequentially/.test(text));
  ok(`${name}: names the worktree per ticket above one slot`, /current checkout with one parallel slot and to a worktree per ticket above one/.test(text));
}
ok('teamwork.md worktree bullet names the slot helper', team.includes('through the `trailhead-auto-slot.js` helper'));

for (const [name, text] of [['auto.md', auto], ['SKILL.md', work], ['teamwork.md', team]]) {
  ok(`${name}: no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}
console.log(`auto-slots-docs.test.js: ${passed} checks passed`);
