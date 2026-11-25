#!/usr/bin/env node
// Docs test: le righe di *Decisions so far* hanno una parte `binds:`, il PLAN le nomina
// in `Constrained by:` e la verifica controlla ciascuna contro il diff.
// Plain asserts, no framework. Run: node bin/decision-binds-docs.test.js
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
const POINTER = '**Decisions so far line**';

// Formato unico, in substrate.md
const substrate = read(`${SK}/_shared/substrate.md`);
const fmt = line(substrate, /^\*\*Decisions so far line\.\*\*.*$/m);
ok('format: paragraph found', fmt.length > 0);
ok('format: binds part first, cut at the middle dot',
  fmt.includes('`- [<title>](<link>): binds: <rule>; <rule> · <summary>`') && /first ` · `/.test(fmt));
ok('format: binds none when nothing binds', fmt.includes('`binds: none`'));
ok('format: a bind is a rule, not a description of the change', /rule later work must respect/i.test(fmt) && /never a description of the change/i.test(fmt));
ok('format: binds part kept short', /about 200 characters/.test(fmt));
ok('format: rules never contain the separator', /never contains ` · `/i.test(fmt));
ok('format: old lines left as they are', /left as they are/i.test(fmt) && /summary only/i.test(fmt));
ok('format: decision Revisit if after the summary', fmt.includes('Revisit if:'));
ok('format: resolution row points at it', /\| Resolution \|.*Decisions so far line/.test(substrate));

// Ogni scrittore punta al formato
const writers = {
  'work SKILL step 5': [read(`${SK}/trailhead-work/SKILL.md`), /^5\. Record the resolution:.*$/m],
  'decision Converge': [read(`${SK}/trailhead-work/references/ticket-engines.md`), /^2\. \*\*Converge\.\*\*.*$/m],
  'decision Complete a revisit': [read(`${SK}/trailhead-work/references/ticket-engines.md`), /^4\. \*\*Complete a revisit\.\*\*.*$/m],
  'build Resolve': [read(`${SK}/trailhead-work/references/ticket-engines.md`), /^5\. \*\*Resolve\*\*: a resolution comment with what was done.*$/m],
  'bug Resolve': [read(`${SK}/trailhead-work/references/ticket-engines.md`), /^5\. \*\*Resolve\*\*: a resolution comment \(cause \+ fix\).*$/m],
  'auto merged slot': [read(`${SK}/trailhead-work/references/auto.md`), /^ *- `merged` or `already-merged`:.*$/m],
  'charting backfill': [read(`${SK}/trailhead-chart/references/charting.md`), /^3\. \*\*Backfill the decisions already made\.\*\*.*$/m],
};
for (const [name, [text, re]] of Object.entries(writers)) {
  const l = line(text, re);
  ok(`${name}: step found`, l.length > 0);
  ok(`${name}: points at the line format`, l.includes(POINTER));
}
const view = read(`${SK}/trailhead-view/SKILL.md`);
ok('map template: line carries binds', view.includes('- [<closed ticket title>](link): binds: <rule; rule | none> · <one-line gist of the answer>'));

// Plan: input DISCUSS e sezione Constrained by
const engines = read(`${SK}/trailhead-work/references/ticket-engines.md`);
const plan = line(engines, /^2\. \*\*Plan\*\*:.*$/m);
ok('plan: step found', plan.length > 0);
ok('plan: DISCUSS comment passed as explicit input', /\*\*Planner inputs\.\*\*/.test(plan) && plan.includes('`DISCUSS` comment') && /also on the inline route/i.test(plan));
ok('plan: map sections passed as input', plan.includes('*Decisions so far*') && plan.includes('*Out of scope*'));
ok('plan: Constrained by section required', plan.includes('`Constrained by:`') && plan.includes('`Constrained by: none`'));
ok('plan: entries are binds parts with their ticket link', /`binds:` part/.test(plan) && /ticket link/i.test(plan));
ok('plan: every DISCUSS oldest first, later wins', /every `DISCUSS` comment/.test(plan) && /oldest first/i.test(plan) && /later one wins/i.test(plan) && !/latest `DISCUSS`/.test(plan));
ok('plan: ticket-less entry uses map link plus quoted rule', /map link plus the quoted rule/i.test(plan));
ok('plan: revisited decision resolves to the live successor line', /live map lines only/i.test(plan) && /successor's line/i.test(plan));
ok('plan: old lines are context only unless a rule is quoted verbatim', /without `binds:` are context only/.test(plan) && /quoted verbatim/i.test(plan));

const blocks = read('scripts/agent-blocks.md');
const planBlock = line(blocks, /<!-- trailhead:agent-block plan -->[\s\S]*?<!-- \/trailhead:agent-block plan -->/);
ok('plan block: ready body lists Constrained by', /`ready`:.*`Constrained by:`/.test(planBlock));
ok('plan agent: synced with Constrained by', read('plugins/trailhead/agents/trailhead-plan.md').includes('`Constrained by:`'));

// Verify: ogni vincolo rispettato o violato, la violazione blocca
const verify = read(`${SK}/_shared/techniques/verify.md`);
const v1 = line(verify, /^1\. \*\*Restate the goal\.\*\*.*$/m);
ok('verify: each Constrained by entry is a claim', v1.includes('`Constrained by:`') && /each entry is a claim/i.test(v1));
ok('verify: checked on the resulting code, the diff sets the scope', /resulting code and its tests/i.test(v1) && /diff sets the scope/i.test(v1));
ok('verify: respected or violated with the decision link', v1.includes('`constraint: <decision link> · respected | violated`'));
ok('verify: violated is unmet, a gap', /`violated` is `class: unmet`/.test(v1) && v1.includes('`gaps_found`'));
ok('verify: scans the live map binds itself, an omitted one is a gap', /reads the live map's `binds:` parts itself/i.test(v1) && /left out is a gap/i.test(v1));
ok('verify: none or missing section adds no claim', v1.includes('`Constrained by: none`') && /older PLAN/i.test(v1));
const routing = line(verify, /^ *\*\*Routing\.\*\*.*$/m);
ok('verify: intentional violation is never a pass', /intentional/i.test(routing) && /never accepted as a pass/i.test(routing));
ok('verify: intentional violation goes to the human or a revisit', /back to the human/i.test(routing) && routing.includes('`Revisits:`') && /explicit yes/i.test(routing));

const reviewing = line(blocks, /<!-- trailhead:agent-block reviewing -->[\s\S]*?<!-- \/trailhead:agent-block reviewing -->/);
ok('verify block: lists each constraint respected or violated', /trailhead-verify:.*`Constrained by:`.*respected.*violated/.test(reviewing));
ok('verify agent: synced', read('plugins/trailhead/agents/trailhead-verify.md').includes('`Constrained by:`'));
const vstep = line(engines, /^4\. \*\*Verify\*\*:.*$/m);
ok('build Verify: violated constraint routes to human or revisit', /violated constraint/i.test(vstep) && vstep.includes('`Revisits:`'));

// Niente em-dash nei file toccati
for (const f of [`${SK}/_shared/substrate.md`, `${SK}/trailhead-work/SKILL.md`, `${SK}/trailhead-work/references/ticket-engines.md`,
  `${SK}/trailhead-work/references/auto.md`, `${SK}/trailhead-view/SKILL.md`, `${SK}/trailhead-chart/references/charting.md`,
  `${SK}/_shared/techniques/verify.md`, 'scripts/agent-blocks.md']) {
  ok(`no em-dash: ${f}`, !read(f).includes(EM));
}

console.log(`decision-binds-docs: ${passed} checks passed`);
