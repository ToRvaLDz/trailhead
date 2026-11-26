#!/usr/bin/env node
// Docs test for #396: the Plan step loads only the codebase facets citing files the change
// touches, through trailhead-facet-touch.js select, and names stale ones as PLAN warnings.
// Plain asserts, no framework. Run: node bin/facet-plan-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const engines = read('plugins/trailhead/skills/trailhead-work/references/ticket-engines.md');
const blocks = read('scripts/agent-blocks.md');
const agent = read('plugins/trailhead/agents/trailhead-plan.md');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const start = engines.indexOf('## `build`');
const planLine = (/^2\. \*\*Plan\*\*.*$/m.exec(engines.slice(start)) || [''])[0];
ok('build Plan step found', planLine !== '');
const i0 = planLine.indexOf('**Planner inputs.**');
const inputs = planLine.slice(i0, planLine.indexOf('The step produces a `PLAN` comment'));
ok('Planner inputs sentence found', i0 >= 0 && inputs.length > 0);

ok('input: the facets citing the touched files, only those', /codebase facets that cite files the change will touch, and only those/.test(inputs));
ok('input: written through a private mktemp -d directory, removed on every path', inputs.includes('mktemp -d') && /removes the directory on every path, also when `select` fails/.test(inputs));
ok('input: ticket body and DISCUSS comments, also on the inline route', inputs.includes('ticket body and its `DISCUSS` comments') && inputs.includes('also on the inline route'));
ok('input: names the script and select with --text-file', inputs.includes('node <templates>/trailhead-facet-touch.js select') && inputs.includes('--text-file'));
ok('input: select is read-only and reuses the Resolve by-file filter', /`select` is read-only/.test(inputs) && /same by-file filter as the Resolve facet check/.test(inputs));
ok('input: states the pre-selection only sees backticked paths', /only sees the backticked paths of the ticket text/.test(inputs));
ok('recheck: the exact command is handed to the planner', /exact recheck command/.test(inputs) && inputs.includes('--repo <working-root>') && inputs.includes('--issue <codebase n>') && inputs.includes('--gh-repo <owner/name>'));
ok('recheck: per file touched with a repeatable --file', inputs.includes('--file <path>') && /repeatable/.test(inputs));
ok('recheck: runs again after every revision, to a fixed point', /after every revision that changes the files touched/.test(inputs) && /fixed point/.test(inputs));
ok('recheck: states why it ends', /only grow and are finite/.test(inputs));
ok('input: by-hand equivalent when the script is missing', /With no script, the by-hand equivalent/.test(inputs));

const sectionAt = planLine.indexOf('The PLAN then carries a `Codebase:` section');
const section = planLine.slice(sectionAt, planLine.indexOf('`Codebase: none`', sectionAt) + 40);
ok('section: after Constrained by', sectionAt > planLine.indexOf('`Constrained by: none`'));
ok('section: built from the last select run on the final files touched', /last `select` run on the final files touched/.test(section));
ok('section: exactly the facets that still cite a touched file', /exactly the facets that still cite one of them/.test(section));
ok('section: a facet no longer selected is left out', /no longer selected is left out/.test(section));
ok('section: warning format with an example', section.includes('`<facet> stale since <stamp>: <changed files>`') && section.includes('Architecture stale since 7d5cd3f: bin/trailhead.js'));
ok('section: trusts the code, Resolve forces the patch or restamp', /trusts the code over the facet/.test(section) && /Resolve facet check then forces the patch or the restamp/.test(section));
ok('section: never a blocker, never needs_input', /never a blocker and never a `needs_input`/.test(section));
ok('section: Codebase: none when nothing applies', section.includes('`Codebase: none`'));

const block = (text) => {
  const m = /<!-- trailhead:agent-block plan -->([\s\S]*?)<!-- \/trailhead:agent-block plan -->/.exec(text);
  return m ? m[1] : '';
};
for (const [name, text] of [['agent-blocks.md', blocks], ['trailhead-plan.md', agent]]) {
  const b = block(text);
  ok(`${name}: plan block present`, b !== '');
  ok(`${name}: ready body lists Codebase: after Constrained by:`, b.indexOf('`Constrained by:`') >= 0 && b.indexOf('`Codebase:`') > b.indexOf('`Constrained by:`'));
  ok(`${name}: planner runs the handed select command to a fixed point`, b.includes('`select` recheck command') && /until a revision leaves them unchanged and no unread facet/.test(b));
  ok(`${name}: built from the last run, warning never blocks`, /last run of the/.test(b) && /never a blocker and never a `needs_input`/.test(b));
}

const touched = [
  'plugins/trailhead/skills/trailhead-work/references/ticket-engines.md',
  'scripts/agent-blocks.md',
  'plugins/trailhead/agents/trailhead-plan.md',
  'plugins/trailhead/skills/_shared/techniques/codebase-map.md',
  'plugins/trailhead/skills/_shared/substrate.md',
  'site/src/content/docs/docs/concepts.md',
];
for (const f of touched) ok(`${f}: no em-dash`, !read(f).includes('—'));

const map = read('plugins/trailhead/skills/_shared/techniques/codebase-map.md');
ok('codebase-map: the Plan reads the relevant facets', /Plan[^.\n]*relevant facets/.test(map));
const substrate = read('plugins/trailhead/skills/_shared/substrate.md');
ok('substrate: the Codebase row says it is read at Plan', /\|[^\n]*trailhead:codebase[^\n]*Read at Plan/.test(substrate));
const concepts = read('site/src/content/docs/docs/concepts.md');
ok('concepts: the codebase bullet mentions the Plan', /trailhead:codebase[^\n]*Plan/.test(concepts));

console.log(`✓ facet-plan-docs: ${passed} assertions passed`);
