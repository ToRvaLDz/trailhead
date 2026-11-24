#!/usr/bin/env node
// Docs test: un revisit e' raggiungibile da `/trailhead:ticket` e da `work` su una decision,
// con una sola domanda e una riga `Revisits:` solo su un si' esplicito.
// Plain asserts, no framework. Run: node bin/decision-revisit-detect-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const EM = String.fromCharCode(0x2014);
const line = (text, re) => (text.match(re) || [''])[0];

const SK = 'plugins/trailhead/skills';

// Chart: ticket su una decision
const chart = read(`${SK}/trailhead-chart/SKILL.md`);
const t = line(chart, /^\*\*Revisit check \(a `decision` ticket\)\.\*\*.*$/m);
ok('ticket: revisit check paragraph found', t.length > 0);
ok('ticket: searches the closed decisions of the same destination',
  t.includes('is:issue is:closed label:trailhead:decision') && t.includes('label:trailhead:map-<n>') && t.includes('label:trailhead:whiteboard'));
ok('ticket: search is complete and paginated', /complete and paginated/i.test(t));
ok('ticket: skip list (superseded, out-of-scope, duplicate)',
  t.includes('`trailhead:superseded`') && t.includes('`trailhead:out-of-scope`') && /duplicate/i.test(t));
ok('ticket: a decision already revisited by a resolved successor offers the successor',
  /resolved successor/i.test(t) && t.includes('`Revisits:`') && /number or URL/.test(t));
ok('ticket: a successor-revisited decision is not itself a candidate, its resolved successor is', /is not itself a candidate/i.test(t) && /its resolved successor is/i.test(t) && /comparison runs on that successor/i.test(t));
ok('ticket: dedupe comes before the ask', t.indexOf('Dedupe first') > -1 && t.indexOf('Dedupe first') < t.indexOf('Matches lead to one ask'));
ok('ticket: several resolved successors are drift, never picked', /more than one resolved successor[^.]*drift/i.test(t) && /never settled by picking one/i.test(t));
ok('ticket: no match creates the ticket with no ask', /no match[^.]*no ask/i.test(t));
ok('ticket: compares the Question, never the title alone', t.includes('`## Question`') && /never the title alone/i.test(t));
ok('ticket: one ask, one option per decision plus none of these', /one ask/i.test(t) && /none of these/i.test(t));
ok('ticket: human-owned, no delegate option', /human-owned/i.test(t) && /no delegate option/i.test(t));
ok('ticket: exactly one predecessor, never picked by the agent', /exactly one predecessor/i.test(t) && /never several/i.test(t) && /never one picked by the agent/i.test(t));
ok('ticket: explicit pick writes `Revisits:` at creation next to `Parent:`', /explicit pick/i.test(t) && t.includes('`Revisits: <old name+link>`') && t.includes('`Parent:`') && /at creation/i.test(t));
ok('ticket: only an explicit none creates without the line', /explicit "none"/i.test(t));
ok('ticket: silence or unclear reply waits, nothing created', /silence or an unclear reply waits/i.test(t) && /nothing is created/i.test(t));
ok('ticket: a declined pair is not asked again in the session', /declined pair is not asked again in that session/i.test(t));
ok('ticket: open ticket already carrying `Revisits:` stops the creation', /is:issue is:open/.test(t) && /name that ticket/i.test(t) && /duplicate/i.test(t));
ok('ticket: audit Revisit stays the third entry point', /audit/i.test(t) && /third entry point/i.test(t));
ok('ticket: no label change', /no label change/i.test(t));
ok('ticket: no em-dash', !chart.includes(EM));

// Motore decision: Diverge
const engines = read(`${SK}/trailhead-work/references/ticket-engines.md`);
const d = line(engines, /^1\. \*\*Diverge \(only if the option space isn't already clear\)\.\*\*.*$/m);
ok('diverge: step found', d.length > 0);
const rc = line(d, /\*\*Revisit check \(always, before the option check\)\.\*\*.*?(?= Mapping the frontier)/);
ok('diverge: revisit check lead-in', rc.length > 0);
ok('diverge: only when the body has no `Revisits:` line and it sits on a map', /no `Revisits:` line/i.test(rc) && /sits on a map/i.test(rc));
ok('diverge: a whiteboard decision is skipped', /whiteboard/i.test(rc) && /does not apply/i.test(rc));
ok('diverge: enumerates Decisions so far and compares the Question', rc.includes('*Decisions so far*') && rc.includes('`## Question`'));
ok('diverge: same skip rule, successor-revisited not a candidate', /same skip rule/i.test(rc) && /resolved successor/i.test(rc));
ok('diverge: the check always runs, even when the option space is clear', /always/i.test(rc) && /whether or not the option space is already clear/i.test(rc));
ok('diverge: open-ticket dedupe', rc.includes('is:issue is:open') && /number or URL/.test(rc) && /stop and name/i.test(rc) && /never two open revisits/i.test(rc));
ok('diverge: no match, no ask', /no match[^.]*no ask/i.test(rc));
ok('diverge: one ask, one predecessor, no delegate option', /one ask/i.test(rc) && /one predecessor/i.test(rc) && /no delegate option/i.test(rc) && /none/i.test(rc));
ok('diverge: pick appends `Revisits:` to the preamble with the fail-safe helper',
  rc.includes('trailhead-issue-body.js append --issue <n> --section :preamble --line') && rc.includes('`Revisits: <old name+link>`'));
ok('diverge: step 4 Complete a revisit then applies at Resolve', /Complete a revisit/.test(rc) && /Resolve/.test(rc));
ok('diverge: explicit none not asked again, silence waits', /explicit "none"/i.test(rc) && /not asked again in that session/i.test(rc) && /silence waits/i.test(rc));
ok('diverge: no label change', /no label change/i.test(rc));
ok('diverge: old resolution is context for the option check', /`Ruled out:`/.test(rc) && /`Revisit if:`/.test(rc));
ok('engines: no em-dash', !engines.includes(EM));

// Docs utente
const cmd = read('site/src/content/docs/docs/commands/chart.md');
ok('chart.md: ticket asks whether a new decision revisits a closed one', /revisit/i.test(cmd) && cmd.includes('`Revisits:`'));
const wf = read('site/src/content/docs/docs/workflow.md');
ok('workflow.md: work asks when the question is already decided', /already (been )?decided/i.test(wf));
for (const [n, x] of [['chart.md', cmd], ['workflow.md', wf]]) ok(`${n}: no em-dash`, !x.includes(EM));

console.log(`decision-revisit-detect-docs.test.js: ${passed} checks passed`);
