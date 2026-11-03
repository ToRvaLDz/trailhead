#!/usr/bin/env node
// Docs test for #352: code review has a fifth axis, Impossible-state guards,
// with an evidence rule, a Warning severity cap and explicit non-findings, and
// the reviewing agent's brief reaches it.
// Run: node guard-axis-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const agents = path.join(root, 'plugins', 'trailhead', 'agents');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const review = read(skills, '_shared', 'techniques', 'code-review.md');
const techniques = read(skills, '_shared', 'techniques.md');
const engines = read(skills, 'trailhead-work', 'references', 'ticket-engines.md');
const agent = read(agents, 'trailhead-code-review.md');

const axis = (review.split('\n').find((l) => l.startsWith('- **Impossible-state guards**')) || '');
const classify = (review.split('\n').find((l) => l.startsWith('Classify each finding')) || '');
const reuse = (review.split('\n').find((l) => l.startsWith('- **Reuse & simplification**')) || '');

ok('code-review.md: review on five axes', review.includes('Review on five axes:'));
ok('code-review.md: no four-axes leftover', !review.includes('Review on four axes'));

ok('axis bullet exists', axis.length > 0);
for (const sub of ['a guard on an impossible state', 'defence already enforced elsewhere', 'a pattern copied without its premises', 'a stale or phantom requirement', 'an abstraction with one instance']) {
  ok(`axis names subtype: ${sub}`, axis.includes(sub));
}
ok('axis extends the speculative generality smell', axis.includes('extends the speculative generality smell'));

ok('axis: the guard code is reachable, the state it guards must be shown impossible',
  axis.includes("the guard's own code must be reachable (live), while the state it guards against must be shown impossible"));
ok('classify: this axis is the exception, what is verified is the impossibility',
  classify.includes('except for Impossible-state guards, where what you verify is that the state cannot occur, not a reachable failing path'));

ok('axis: every finding cites concrete evidence the state cannot occur',
  axis.includes('Every finding cites concrete evidence (file:line or a doc) that the state cannot occur'));
ok('axis: admissible evidence kinds',
  axis.includes('a closed type or enum, an API or framework invariant, fixed configuration, validation already done upstream, or a guarantee of the stack itself'));
ok('axis: no evidence, no finding, never the reviewer\'s say-so',
  axis.includes("Without such evidence there is no finding, never the reviewer's say-so"));

ok('axis: severity cap', axis.includes('at most Warning, never Critical, so it never enters the Critical-only fix-and-re-review loop'));
ok('classify: severity cap', classify.includes('Impossible-state guards findings are at most Warning, never Critical, so they never enter the Critical-only fix-and-re-review loop'));

ok('axis: explicit non-findings',
  axis.includes('Not findings: trust boundaries (user input, network, files, env), deliberate defence-in-depth, test and DI seams, and dead code (a separate smell, not this axis)'));

ok('reuse smell list points to the new axis', /speculative generality \(delete; see \*\*Impossible-state guards\*\*\)/.test(reuse));

ok('techniques.md: protocol carried in the spawn prompt', techniques.includes('carries its full protocol in the prompt'));
ok('techniques.md: Code review row on 5 axes', techniques.includes("review the ticket's own commits (its `Refs: #<n>` set) on 5 axes"));
const verifyLines = engines.split('\n').filter((l) => l.startsWith('4. **Verify**'));
ok('ticket-engines.md: build and bug Verify found', verifyLines.length === 2);
ok('ticket-engines.md: both Verify lines reference techniques/code-review.md', verifyLines.every((l) => l.includes('techniques/code-review.md')));
ok('agent: names the injected single source', agent.includes('injected at spawn from the trailhead skill\'s single source (`_shared/techniques/code-review.md`)'));

for (const [name, text] of Object.entries({ 'code-review.md': review, 'techniques.md': techniques, 'guard-axis-docs.test.js': read(__dirname, 'guard-axis-docs.test.js') })) {
  ok(`${name} has no em-dash`, !text.includes('—'));
}

console.log(`guard-axis-docs.test.js: ${passed} checks passed`);
