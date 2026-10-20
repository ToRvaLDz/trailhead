#!/usr/bin/env node
// Docs test for #287: an autonomous run opens, or updates, one merge ticket per map (or
// the whiteboard) for the slot branches it leaves unmerged, right when each arises.
// Plain asserts, no framework. Run: node bin/auto-merge-ticket-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const plugin = path.resolve(__dirname, '..', 'plugins', 'trailhead');
const auto = fs.readFileSync(path.join(plugin, 'skills/trailhead-work/references/auto.md'), 'utf8');
const commands = fs.readFileSync(path.join(plugin, 'skills/_shared/substrate-commands.md'), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

ok('auto.md: names the add call with scope, ticket, file, workspace and repo', auto.includes('trailhead-merge-ticket.js add --scope <map-<n>|whiteboard> --ticket <n> --file <path> [--file <path> ...] --workspace <path> --repo <owner/name>'));
ok('auto.md: one --file per conflicting path of the merge result', /one `--file` per path in the merge result's `conflicts`/.test(auto));
ok('auto.md: the add runs right after the abort, before parking', /right after the abort, before parking/i.test(auto));
ok('auto.md: the park reason names the branch, workspace, files and the merge ticket', /park reason names the branch, the workspace, the conflicting files and the merge ticket/.test(auto));
ok('auto.md: one merge ticket per map or the whiteboard, opened at the first unmerged branch, updated after each later one', /one merge ticket per map \(or the whiteboard\)[^\n]*opened at the first unmerged branch[^\n]*updated after each later one/.test(auto));
ok('auto.md: never only at run end', /never only at run end/.test(auto));
ok('auto.md: a needs-you task so no run takes it, closed by the human', /needs-you `task`[^\n]*no run takes it[^\n]*closed by the human/.test(auto));
ok('auto.md: a map or the whiteboard with no unmerged branch gets no merge ticket', /no unmerged branch gets no merge ticket/.test(auto));
ok('auto.md: records as it goes names the merge ticket', /Records as it goes\n[^\n]*merge ticket/.test(auto));
ok('auto.md: run-end summary names the merge tickets', /\*\*what merged\*\*[^\n]*merge tickets/.test(auto));
ok('auto.md: a helper error is reported, named in the park reason, retried once at run end', /helper error[^\n]*reported in chat[^\n]*named in the park reason[^\n]*retried once at run end/.test(auto));
ok('auto.md: a still-failing retry is listed as no merge ticket written', /no merge ticket written/.test(auto));
ok('substrate-commands.md: names the helper and its call', commands.includes('trailhead-merge-ticket.js add --scope') && commands.includes('--workspace <path> --repo <owner/name>'));
ok('substrate-commands.md: finds through GraphQL OPEN with the marker', /trailhead:merge-ticket/.test(commands) && /states OPEN|OPEN issues/.test(commands));
ok('substrate-commands.md: an error is unknown, never none found', /merge ticket[^\n]*unknown, never as none found/.test(commands));
ok('no em-dash in auto.md', !auto.includes(String.fromCharCode(0x2014)));
ok('no em-dash in substrate-commands.md', !commands.includes(String.fromCharCode(0x2014)));
console.log(`auto-merge-ticket-docs.test.js: ${passed} checks passed`);
