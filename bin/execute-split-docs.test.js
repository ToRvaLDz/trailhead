#!/usr/bin/env node
// Pins the Execute/Fix split (#251): the executor-side text lives in
// trailhead-work/references/executor-brief.md (the one text injected at spawn),
// while the Execute (build) and Fix (bug) steps of ticket-engines.md keep only
// the orchestrator moves. Run: node execute-split-docs.test.js. No framework.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const plugin = path.join(__dirname, '..', 'plugins', 'trailhead');
const refs = path.join(plugin, 'skills', 'trailhead-work', 'references');
const briefPath = path.join(refs, 'executor-brief.md');
const exists = fs.existsSync(briefPath);
ok('executor-brief.md exists', exists);
const brief = fs.readFileSync(briefPath, 'utf8');
const lb = brief.toLowerCase();
const engines = fs.readFileSync(path.join(refs, 'ticket-engines.md'), 'utf8');
const lines = engines.split('\n');

const block = (startPrefix, from = 0) => {
  const s = lines.findIndex((l, i) => i >= from && l.startsWith(startPrefix));
  if (s === -1) return '';
  const e = lines.findIndex((l, i) => i > s && l.startsWith('4. **Verify**'));
  return lines.slice(s, e === -1 ? undefined : e).join('\n');
};
const execute = block('3. **Execute**');
const fix = block('3. **Fix**');
ok('the build Execute block was found', execute.length > 500);
ok('the bug Fix block was found', fix.length > 500);

// --- the brief: what the executor does ---------------------------------------------------
const has = (src, ...needles) => needles.every((n) => src.includes(n));
ok('brief: atomic conventional commits with a Refs trailer', has(brief, 'atomic', 'conventional', 'Refs: #<n>'));
ok('brief: one commit = one verifiable step', brief.includes('One commit = one verifiable step'));
ok('brief: TDD per the config.tdd value passed', has(brief, 'config.tdd', '`seams`', '`on`', '`off`'));
ok('brief: a fix gets a test that fails before and passes after', lb.includes('fails before and passes after'));
ok('brief: dependency vetting criteria', has(lb, 'typosquat', 'age', 'downloads', 'repository metadata'));
ok('brief: the sentinel re-run of the exact command', has(brief, 'TRAILHEAD_VERIFIED_INSTALL=1', 'exact'));
ok('brief: sentinel only when clean or passed as user-approved', lb.includes('user-approved') && lb.includes('clean'));
ok('brief: a suspicious package: stop and report, never install, never set the sentinel',
  lb.includes('suspicious') && lb.includes('stop and report') && lb.includes('never install') && lb.includes('never set'));
ok('brief: 100% fidelity to a passed approved mockup', brief.includes('100% fidelity') && lb.includes('approved mockup'));
ok('brief: infeasible element: stop and report, never silently deviate',
  lb.includes('infeasible') && lb.includes('never silently deviate'));
ok('brief: returns the enumerated fidelity list in its report', brief.includes('enumerated fidelity list'));
ok('brief: new scope is reported, not worked', lb.includes('scope') && lb.includes('reported, not worked'));
const report = brief.slice(brief.indexOf('## Report'));
ok('brief: has a Report section', brief.includes('## Report'));
ok('brief: Report names flagged packages with exact install command and evidence',
  has(lb.slice(lb.indexOf('## report')), 'flagged package', 'exact install command', 'evidence'));
ok('brief: Report names the fidelity list as element/state -> reproduced or infeasible with why',
  has(report, 'element/state', 'reproduced or infeasible', 'why'));
ok('brief: Report names surfaced scope', report.toLowerCase().includes('surfaced scope'));
ok('brief: the fixed report shape is left to the return contract (#249)', report.includes('#249'));

// --- the brief carries none of the orchestrator-only moves ---------------------------------
ok('brief: no AskUserQuestion', !brief.includes('AskUserQuestion'));
ok('brief: no "ask the user"', !lb.includes('ask the user'));
ok('brief: no config.design', !brief.includes('config.design'));
ok('brief: no Prototype technique instruction', !lb.includes('prototype technique'));
ok('brief: no gh issue / gh pr tracker write', !/gh (issue|pr)\b/.test(lb));
ok('brief: no branch or PR creation', !/(create|creates|creating|open|opens) (the |a )?(branch|pr\b|pull request)/.test(lb));
ok('brief: no em-dash', !brief.includes('—'));

// --- the build Execute block: the orchestrator part --------------------------------------------
const lx = execute.toLowerCase();
ok('Execute: Prototype FIRST', execute.includes('Prototype technique') && execute.includes('FIRST'));
ok('Execute: config.design routing, never a hosted mode to a local disk mockup',
  has(execute, 'config.design', 'never shortcut a hosted mode to a local disk mockup'));
ok('Execute: config.design.approval gate', has(execute, 'config.design.approval', '`explicit`', '`auto`'));
ok('Execute: branch before the spawn and PR after under git: pr',
  has(execute, 'git: pr', 'the orchestrator creates the branch before the spawn and opens the PR'));
ok('Execute: worktree under isolation: worktree', has(execute, 'isolation: worktree', 'git worktree'));
ok('Execute: posts the fidelity list as a ticket comment',
  has(execute, 'returns the enumerated fidelity list in its report', 'the orchestrator posts it as a ticket comment'));
ok('Execute: an infeasible element is raised with the user and settled',
  lx.includes('infeasible') && lx.includes('revise and re-approve the mockup') && lx.includes('accepts a named deviation'));
ok('Execute: re-spawns with the settled mockup and accepted deviations',
  lx.includes('re-spawn') && lx.includes('accepted deviations'));
ok('Execute: block-and-ask on a flagged package', lx.includes('block-and-ask') && lx.includes('flagged package'));
ok('Execute: only on an explicit yes re-spawn with the package as user-approved',
  lx.includes('explicit yes') && lx.includes('user-approved'));
ok('Execute: on a no the package is not installed and the plan is revisited',
  lx.includes('not installed') && lx.includes('revisited with the user'));
ok('Execute: captures surfaced scope', lx.includes('surfaced scope') && lx.includes('captured'));
ok('Execute: dispatches trailhead-executor on config.models.execute',
  has(execute, '`trailhead-executor`', 'config.models.execute'));
ok('Execute: the brief is the only protocol text', has(execute, 'executor-brief.md', 'only protocol text'));
ok('Execute: lists the runtime inputs',
  has(lx, 'ticket number', 'plan', 'base sha', 'config.tdd', 'mockup link', 'accepted mockup deviations'));
ok('Execute: inline when the model is unset or equals the session model', lx.includes('inline') && lx.includes('session'));

// --- the bug Fix block: self-contained ------------------------------------------------------------
const lf = fix.toLowerCase();
ok('Fix: dispatches trailhead-fix on config.models.execute with the brief as the only protocol text',
  has(fix, '`trailhead-fix`', 'config.models.execute', 'executor-brief.md', 'only protocol text'));
ok('Fix: lists the runtime inputs',
  has(lf, 'ticket number', 'base sha', 'config.tdd', 'mockup link', 'accepted mockup deviations'));
ok('Fix: UI-fix Prototype + approval',
  has(fix, 'Prototype technique', 'config.design', 'config.design.approval') && lf.includes('ui'));
ok('Fix: posts the fidelity list as a ticket comment',
  has(fix, 'enumerated fidelity list', 'the orchestrator posts it as a ticket comment'));
ok('Fix: infeasible element settle-and-re-spawn loop',
  lf.includes('infeasible') && lf.includes('revise and re-approve the mockup') && lf.includes('accepts a named deviation') && lf.includes('re-spawn'));
ok('Fix: block-and-ask on a flagged package with explicit-yes resume',
  lf.includes('block-and-ask') && lf.includes('flagged package') && lf.includes('explicit yes') && lf.includes('user-approved'));
ok('Fix: captures surfaced scope', lf.includes('surfaced scope') && lf.includes('captured'));
ok('Fix: branch before the spawn and PR under git: pr',
  has(fix, 'git: pr', 'the orchestrator creates the branch before the spawn and opens the PR'));
ok('Fix: worktree under isolation: worktree', has(fix, 'isolation: worktree', 'git worktree'));

// --- agents point to the brief -----------------------------------------------------------------------------
for (const a of ['trailhead-executor', 'trailhead-fix']) {
  const md = fs.readFileSync(path.join(plugin, 'agents', `${a}.md`), 'utf8');
  ok(`${a}.md points to executor-brief.md`, md.includes('trailhead-work/references/executor-brief.md'));
}
const techniques = fs.readFileSync(path.join(plugin, 'skills', '_shared', 'techniques.md'), 'utf8');
ok('techniques.md: Execute and Fix inject executor-brief.md, not the whole step',
  techniques.includes('trailhead-work/references/executor-brief.md'));

// --- no behaviour lost from the pre-split Execute paragraph ------------------------------------------------------
const both = execute + '\n' + brief;
for (const needle of [
  'Prototype technique', 'FIRST', 'config.design', 'never shortcut a hosted mode to a local disk mockup',
  'config.design.approval', '100% fidelity', 'fidelity list', 'Acceptance testing', 'Goal-backward verification',
  'atomic commits', 'Refs: #<n>', '`git:`', 'git worktree', 'config.models.execute', '`trailhead-executor`',
  'verify-before-install', 'TRAILHEAD_VERIFIED_INSTALL', 'block-and-ask', 'captured',
]) {
  ok(`no behaviour lost: "${needle}" is in the Execute block or the brief`, both.includes(needle));
}

for (const [label, src] of [['executor-brief.md', brief], ['ticket-engines.md', engines], ['techniques.md', techniques]]) {
  ok(`${label}: no em-dash`, !src.includes('—'));
}

console.log(`execute-split-docs.test.js: ${passed} checks passed`);
