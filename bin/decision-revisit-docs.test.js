#!/usr/bin/env node
// Docs test: quando una decision con `Revisits: <vecchia>` si risolve, la sua riga
// sostituisce quella vecchia in Decisions so far, la vecchia riceve un commento
// `Revisited by:` senza cambi di label, i build aperti su `Decided in: <vecchia>`
// vanno nella conferma finale e l'audit classa la vecchia come evolved.
// Plain asserts, no framework. Run: node bin/decision-revisit-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const EM = String.fromCharCode(0x2014);

// Sezione dal suo heading fino al prossimo heading dello stesso livello (o superiore).
const section = (text, headingRe) => {
  const m = headingRe.exec(text);
  if (!m) return '';
  const level = m[0].match(/^#+/)[0].length;
  const rest = text.slice(m.index + m[0].length);
  const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
  return next ? rest.slice(0, next.index) : rest;
};
const line = (text, re) => (text.match(re) || [''])[0];

const SK = 'plugins/trailhead/skills';

// Motore decision: la regola canonica
const engines = read(`${SK}/trailhead-work/references/ticket-engines.md`);
const dec = section(engines, /^## `decision`.*$/m);
const rev = line(dec, /^4\. \*\*Complete a revisit\.\*\*.*$/m);
ok('decision revisit: step found', rev.length > 0);
ok('decision revisit: applies to a ticket carrying `Revisits:`', rev.includes('`Revisits: <'));
ok('decision revisit: at Resolve, never at creation', /never at (its )?creation/i.test(rev));
ok('decision revisit: replaces the old Decisions so far line', /Decisions so far\* line replaces the old decision's line/i.test(rev));
ok('decision revisit: one whole-section write via the helper', /one idempotent write/i.test(rev) && rev.includes('trailhead-issue-body.js replace'));
ok('decision revisit: never two lines or none for the question', /never holds two lines or none/i.test(rev));
ok('decision revisit: a rerun writes nothing', /rerun[^.]*writes nothing/i.test(rev));
ok('decision revisit: a missing or repeated old line on a map is drift, asked', /drift/i.test(rev) && /never a silent no-op/i.test(rev));
ok('decision revisit: no duplicate `Revisited by:` comment', /unless one naming this successor is already there/i.test(rev));
ok('decision revisit: dispositions before the close, line and comment right after it', /dispositions are applied before the close/i.test(rev) && /right after the successor's close/i.test(rev));
ok('decision revisit: an interrupted Resolve is completed by rerunning', /interrupted Resolve is completed by rerunning/i.test(rev));
ok('decision revisit: comment dedupe reads all comments, paginated, by number or URL', /all of its comments, paginated/i.test(rev) && /number or URL/.test(rev));
ok('decision revisit: also on a reaffirm, with its own `Revisit if:`', /reaffirm/i.test(rev) && rev.includes('`Revisit if:`'));
ok('decision revisit: whiteboard decision gets only the comment', /whiteboard/i.test(rev) && /only the comment/i.test(rev));
ok('decision revisit: `Revisited by:` comment on the old decision', rev.includes('`Revisited by: <successor name+link>`'));
ok('decision revisit: old stays closed as resolved', /stays closed as resolved/i.test(rev));
ok('decision revisit: no `trailhead:superseded`, no new label', rev.includes('no `trailhead:superseded`') && /no new label/i.test(rev));
ok('decision revisit: sub-issue edge stays', /sub-issue edge stays/i.test(rev));

// Carry it into build: i build aperti sulla vecchia decisione
const carry = line(dec, /^3\. \*\*Carry it into build\.\*\*.*$/m);
ok('carry: lists open tickets carrying `Decided in: <old>`', carry.includes('`Decided in: <old>`') && /open ticket/i.test(carry));
ok('carry: disposition keep adds `Decided in: <successor>`', /keep/i.test(carry) && carry.includes('`Decided in: <successor>`'));
ok('carry: disposition rescope', /rescope/i.test(carry));
ok('carry: disposition close as out of scope', /out of scope/i.test(carry));
ok('carry: on a reaffirm only the `Decided in:` line is added', /reaffirm[^.]*only the `Decided in:` line/i.test(carry));
ok('carry: closed builds are left to the audit', /closed builds are left to the audit/i.test(carry));
ok('decision engine: no em-dash', !dec.includes(EM));

// Work the map step 5
const work = read(`${SK}/trailhead-work/SKILL.md`);
const step5 = line(work, /^5\. Record the resolution:.*$/m);
ok('work step 5: a `Revisits:` decision replaces instead of appending', step5.includes('`Revisits:`') && /Complete a revisit/.test(step5));

// Grill standalone che risolve un decision
const chart = read(`${SK}/trailhead-chart/SKILL.md`);
const grill = line(chart, /^Run a standalone \*\*Grilling\*\*.*$/m);
ok('grill: a resolved `Revisits:` decision completes the revisit', grill.includes('`Revisits:`') && /Complete a revisit/.test(grill));

// Audit
const audit = read(`${SK}/trailhead-manage/references/auditing.md`);
const light = line(audit, /^\*\*Light check\*\*.*$/m);
ok('audit light check: resolved `Revisits:` successor makes the old decision evolved', light.includes('`Revisits:`') && /\*\*evolved by\*\*/.test(light));
ok('audit light check: never re-checked as a regression', /never re-checked as a regression/i.test(light));
ok('audit light check: successor found by the exhaustive step 4b search', /exhaustive, paginated search as step 4b/i.test(light) && /number or URL/.test(light));
ok('audit light check: successor must be resolved (not superseded, out-of-scope, duplicate)',
  /completed state reason/i.test(light) && light.includes('not `trailhead:superseded`') && light.includes('not `trailhead:out-of-scope`') && /duplicate/i.test(light));
const props = section(audit, /^## 9\. Proposals.*$/m);
const revisit = line(props, /^- \*\*Revisit\*\*.*$/m);
ok('audit light check: several resolved successors are drift, never picked arbitrarily', /More than one resolved successor[^.]*drift/i.test(light) && /never one picked arbitrarily/i.test(light));
ok('audit proposals: revisit points at Complete a revisit', /Complete a revisit/.test(revisit));
ok('audit: no em-dash', !audit.includes(EM));

// Docs utente
const wf = read('site/src/content/docs/docs/workflow.md');
ok('workflow.md: a revisit replaces the old map line', /revisit/i.test(wf) && /Revisited by:/.test(wf));
const manage = read('site/src/content/docs/docs/commands/manage.md');
ok('manage.md: audit reports a revisited decision as evolved', /revisited/i.test(manage) && /evolved/i.test(manage));
for (const [n, t] of [['workflow.md', wf], ['manage.md', manage], ['SKILL.md', work], ['chart SKILL.md', chart]]) {
  ok(`${n}: no em-dash`, !t.includes(EM));
}

console.log(`decision-revisit-docs.test.js: ${passed} checks passed`);
