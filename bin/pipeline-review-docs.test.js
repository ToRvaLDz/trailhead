#!/usr/bin/env node
// Docs test for #355: code review loads a CI/CD pipeline reliability reference
// on a pipeline-touching diff only, every finding capped at Warning, and the
// review brief, the techniques table and the agent all point at it.
// Run: node pipeline-review-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const agents = path.join(root, 'plugins', 'trailhead', 'agents');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const refPath = path.join(skills, '_shared', 'techniques', 'code-review-pipeline.md');
ok('reference file exists', fs.existsSync(refPath));
const ref = read(refPath);
const review = read(skills, '_shared', 'techniques', 'code-review.md');
const techniques = read(skills, '_shared', 'techniques.md');
const agent = read(agents, 'trailhead-code-review.md');

const route = review.split('\n').find((l) => l.startsWith('**First, route it.**')) || '';
const para = review.split('\n').find((l) => l.startsWith('**Pipeline reliability (only on a pipeline-touching diff)**')) || '';
const lines = review.split('\n');
const classifyIdx = lines.findIndex((l) => l.startsWith('Classify each finding'));
const paraIdx = lines.findIndex((l) => l.startsWith('**Pipeline reliability (only on a pipeline-touching diff)**'));
const guardIdx = lines.findIndex((l) => l.startsWith('- **Impossible-state guards**'));

// The reference: the eight checks.
for (const sub of [
  '`npm install` where a lockfile exists (use `npm ci` instead)',
  'a job without `timeout-minutes`',
  'a deploy without a `concurrency` group',
  'a rebuild per environment instead of build once, promote',
  'applies only when the workflow targets more than one environment',
  'a deploy with neither a health check nor a rollback',
  '`continue-on-error` on a step that later steps depend on',
  'static cloud keys where the provider supports OIDC',
  'a third-party action on `@main` or `@latest`',
]) {
  ok(`reference check: ${sub}`, ref.includes(sub));
}

ok('reference: every finding is a Warning, never Critical',
  ref.includes('Every finding is a Warning, never Critical, so it never enters the Critical-only fix-and-re-review loop'));

for (const sub of [
  'global tool installs (`npm install -g`)',
  'reusable workflows (a job calling one takes neither `timeout-minutes` nor steps of its own)',
  'actions already pinned to a tag',
  'test-only workflows (a workflow that runs tests and publishes or deploys nothing: none of the checks apply)',
]) {
  ok(`reference non-finding: ${sub}`, ref.includes(sub));
}

ok('reference: hardcoded secrets stay Critical under Security',
  ref.includes('Hardcoded secrets are not in this reference: they stay Critical under the Security axis'));
ok('reference: a deploy finding names what makes it a deploy one',
  ref.includes('A deploy finding names what makes the workflow a deploy one (a quoted command, an `environment:`, a target)'));
ok('reference: scope is the ticket diff',
  ref.includes("only jobs and steps the ticket's commits add or change, per the Ticket diff rule"));
ok('reference: not a sixth axis', ref.includes('not a sixth axis'));

// The brief: route paragraph.
ok('route: first-line route structure kept', route.includes('**First, route it.** Run `node <hooks>/lib/model-route.js review'));
ok('route: spawn prompt carries the pipeline reference line', route.includes('`pipeline reference: <absolute path>`'));
ok('route: path is code-review-pipeline.md beside the code-review.md just read',
  route.includes('`code-review-pipeline.md` in the same directory as the `code-review.md` you just read by absolute path'));
ok('route: path only, never the contents', route.includes('never the reference\'s contents'));

// The brief: the new paragraph.
ok('five axes wording kept', review.includes('Review on five axes:'));
ok('paragraph exists', para.length > 0);
ok('paragraph sits after the axes and before Classify', guardIdx >= 0 && paraIdx > guardIdx && paraIdx < classifyIdx);
for (const sub of [
  'git -C <repo> show --format= --name-only <sha>',
  '`.github/workflows/*`',
  '`Dockerfile*`',
  '`docker-compose*`',
  '(basename, at any depth)',
  'a script with `deploy` in its file name',
  'a release script under another name is not matched',
  'on every pass including the lean inline one',
  'otherwise do not read it',
  'Inline, it sits beside this file',
  'the review is incomplete and fails closed',
  'a Critical finding `pipeline checks did not run` naming the matched path',
  'status is `issues_found` and Resolve stays blocked',
  'discards that incomplete report',
  'never enters the ledger',
  're-spawns with the path',
  'HITL checkpoint naming the path',
  'It is not a sixth axis',
]) {
  ok(`paragraph: ${sub}`, para.includes(sub));
}

// Pointers.
ok('techniques.md: Code review row on 5 axes kept', techniques.includes("review the ticket's own commits (its `Refs: #<n>` set) on 5 axes"));
ok('techniques.md: row names the conditional reference', techniques.includes('code-review-pipeline.md'));
ok('agent: names the reference at the path the spawn names',
  agent.includes('`code-review-pipeline.md`') && agent.includes('the path the spawn names'));
ok('agent: injected single source kept', agent.includes('injected at spawn from the trailhead skill\'s single source (`_shared/techniques/code-review.md`)'));

for (const [name, text] of Object.entries({
  'code-review-pipeline.md': ref,
  'code-review.md': review,
  'techniques.md': techniques,
  'trailhead-code-review.md': agent,
  'pipeline-review-docs.test.js': read(__dirname, 'pipeline-review-docs.test.js'),
})) {
  ok(`${name} has no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}

console.log(`pipeline-review-docs.test.js: ${passed} checks passed`);
