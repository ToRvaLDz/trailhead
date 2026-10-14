#!/usr/bin/env node
// Pins the report status protocol in the shipped skills (#250, #249): the
// canonical "Malformed review report" paragraph (every engine-agent report) and
// VERIFY comment layout in _shared/techniques.md, the clause on both Verify lines of
// ticket-engines.md, the return-not-post wording in the verify and code-review
// techniques, and how Plan, Execute, Fix, Diagnose, research and the codebase map
// read the fields of their agent's report.
// Run: node report-status-docs.test.js. No framework: plain asserts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const skills = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const read = (...p) => fs.readFileSync(path.join(skills, ...p), 'utf8');
const techniques = read('_shared', 'techniques.md');
const verify = read('_shared', 'techniques', 'verify.md');
const codeReview = read('_shared', 'techniques', 'code-review.md');
const acceptance = read('_shared', 'techniques', 'acceptance-testing.md');
const engines = read('trailhead-work', 'references', 'ticket-engines.md');
const brief = read('trailhead-work', 'references', 'executor-brief.md');
const research = read('_shared', 'techniques', 'research.md');
const codebaseMap = read('_shared', 'techniques', 'codebase-map.md');
const debug = read('_shared', 'techniques', 'debug.md');
const charting = read('trailhead-chart', 'references', 'charting.md');
const researchAgent = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'trailhead', 'agents', 'trailhead-research.md'), 'utf8');

// --- the canonical paragraph -------------------------------------------------------
const start = techniques.indexOf('**Malformed review report');
ok('techniques.md has the Malformed review report paragraph', start !== -1);
const neverBlock = techniques.indexOf('**Reviews never block the session');
ok('the paragraph sits next to "Reviews never block the session"',
  start !== -1 && neverBlock !== -1 && Math.abs(start - neverBlock) < 2500 && start > neverBlock);
const para = start === -1 ? '' : techniques.slice(start, techniques.indexOf('\n| Technique |', start));
const lc = para.toLowerCase();
ok('the paragraph section was found and is bounded', para.length > 1000 && !para.includes('| **Grilling**'));

ok('it MUST run on every engine-agent report, the two reviews included', /MUST run on every/.test(para)
  && para.includes('Code review') && para.includes('Goal-backward verification'));
ok('it names every technique it covers',
  ['plan', 'executor', 'fix', 'debug', 'research', 'codebase-map'].every((t) => para.includes(t)) && lc.includes('every engine-agent report'));
ok('the checker line carries fields and body', para.includes('{"action","verdict","problem","report","fields","body"}'));
ok('it covers subagent, inline and the lean inline pass', lc.includes('subagent') && lc.includes('inline') && lc.includes('lean inline pass'));
ok('the checker command with its technique flag and a report file',
  para.includes('node <templates>/trailhead-report-status.js --technique <verify|code-review|plan|executor|fix|debug|research|codebase-map> --file <that dir>/report.md'));
ok('the three templates dirs, in order',
  (() => {
    const a = para.indexOf('${CLAUDE_PLUGIN_ROOT}/templates/');
    const b = para.indexOf('~/.claude/trailhead/templates/');
    const c = para.indexOf('~/.codex/skills/trailhead/templates/');
    return a !== -1 && b > a && c > b;
  })());
ok('the plugin root dir is skipped when unset', lc.includes('skipped when unset'));
ok('a private temp dir from mktemp -d, once per report', para.includes('`mktemp -d`') && lc.includes('once') && lc.includes('0700'));
ok('the raw report is written to report.md at the literal printed path with the Write tool',
  para.includes('<that dir>/report.md') && para.includes('Write tool') && lc.includes('literal printed path'));
ok('the dir is removed with rm -rf at the literal absolute path', para.includes('rm -rf <that dir>') && lc.includes('literal absolute path'));
ok('cleanup runs after every path',
  lc.includes('cleanup runs after every path') && ['accept', 'normalise', 're-ask check', 'second failure', 'checker failure'].every((w) => lc.includes(w)));
ok('never a fixed or predictable path, never reused', lc.includes('never a fixed or predictable path') && lc.includes('never reused'));
ok('stdin stays a CLI input but the protocol does not use it', lc.includes('stdin') && lc.includes('does not use'));
ok('the checker-returned report replaces the raw report', lc.includes('checker-returned `report` replaces the raw report'));
ok('the engine branches only on the returned verdict', para.includes('branches only on the returned `verdict`'));
ok('the engine reads the returned fields and body, never re-derives them from prose',
  para.includes('reads the returned `fields`') && para.includes('`body`') && lc.includes('instead of re-deriving them from the prose'));
ok('reask: ask once, continue the same agent where the host allows, else re-dispatch',
  lc.includes('ask once') && lc.includes('continue the same agent') && lc.includes('re-dispatch the same `trailhead-<technique>` agent')
  && lc.includes('same model override') && lc.includes('malformed report quoted'));
const prompt = 'Your report could not be accepted: `<problem>` (missing: no `status:` line; unknown-token: `<found>` is not an allowed token; '
  + 'conflicting: more than one `status:` line, so quote or reword any status text in the body, which must not start a line with `status:` outside a code fence or blockquote; counts: the counts line is missing or repeated; fields: a required field is missing or an invariant is broken). '
  + 'Return the complete report again with its first line exactly `status: <token>`, where `<token>` is one of `<allowed tokens>`, '
  + 'and no other `status:` line<for code-review: , and its second line exactly `critical: <n> · warning: <n> · info: <n>`>'
  + '<for fields: , with each of `<required fields>` as a top-level `<label>:` line and `<the broken invariant>` holding, with nothing after the last field>. '
  + 'Do not post it anywhere.';
ok('the corrective prompt, verbatim', para.includes(prompt));
ok('for code-review the prompt always restates both required lines', lc.includes('always restates both required lines'));
ok('for fields the prompt names the missing fields and the broken invariant', lc.includes('names the missing or empty fields and the invariant that broke'));
ok('the reply is re-checked', lc.includes('re-check'));
ok('a second failure: no verdict, nothing posted, no third ask, no inference from the body',
  lc.includes('no verdict') && lc.includes('nothing posted') && lc.includes('no third ask') && lc.includes('no inference from the body'));
ok('a second failure: HITL checkpoint naming the technique and the problem, Resolve stays blocked',
  para.includes('HITL checkpoint') && lc.includes('naming the technique and the problem') && lc.includes('resolve stays blocked'));
ok('the previous VERIFY comment stays latest', lc.includes('previous `verify` comment stays latest'));
ok('a step that needed the report stays blocked too', lc.includes('so does any step that needed the report'));
ok('the layout part is for the reviewing pair only', para.includes('**VERIFY comment layout (the reviewing pair only).**'));
ok('checker missing, exit 2 or non-JSON: apply the same rules by hand, never guess',
  lc.includes('checker is missing') && lc.includes('exit 2') && lc.includes('non-json') && lc.includes('by hand') && lc.includes('never guess a verdict'));

// --- the VERIFY comment layout ------------------------------------------------------
ok('layout: one VERIFY comment per Verify round', /one `VERIFY` comment per Verify round/.test(para));
ok('layout part 1: the code-review report verbatim, status line 1, counts line 2, ledger, findings',
  lc.includes('code-review report verbatim') && lc.includes('counts line 2') && lc.includes('ledger'));
ok('layout part 2: a "## Goal-backward verification" heading and the verify report verbatim',
  para.includes('`## Goal-backward verification` heading') && lc.includes('verify report verbatim'));
ok('layout part 3: test or criterion outcome, then acceptance testing results',
  lc.includes('test/criterion outcome') && lc.includes('acceptance-testing results'));
ok('layout: an issues_found round posts parts 1 and 3 only', lc.includes('`issues_found` posts parts 1 and 3 only'));
ok('layout: a verify-only round repeats the latest code-review report verbatim as part 1',
  lc.includes('repeats the latest checker-returned code-review report verbatim as part 1'));
ok('layout: the latest VERIFY comment holds the counts line and ledger', lc.includes('latest `verify` comment always holds the authoritative counts line and ledger'));
ok('layout: the engine never reads the comment back to branch', lc.includes('never by reading the comment back'));

// --- both Verify lines -----------------------------------------------------------------
const verifyLines = engines.split('\n').filter((l) => l.trim().startsWith('4. **Verify**'));
ok('ticket-engines.md has exactly two Verify (step 4) lines', verifyLines.length === 2);
for (const [i, l] of verifyLines.entries()) {
  ok(`Verify line ${i + 1}: run the report-status check before branching on status`, l.includes('run the report-status check before branching on status'));
  ok(`Verify line ${i + 1}: points to the paragraph by name`, l.includes('*Malformed review report*') && l.includes('../../_shared/techniques.md'));
  ok(`Verify line ${i + 1}: points to the VERIFY comment layout`, l.includes('layout'));
  ok(`Verify line ${i + 1}: keeps the Ticket diff reference (#181)`, l.includes('**Ticket diff**'));
}

// --- the techniques return, the orchestrator posts --------------------------------------
ok('verify.md: "Return the verdict" with a leading status', verify.includes('Return the verdict with a leading `status:`'));
ok('verify.md: the orchestrator posts it under the Goal-backward verification heading of the round\'s VERIFY comment',
  verify.includes('the orchestrator posts it') && verify.includes('`## Goal-backward verification` heading') && verify.includes("round's `VERIFY` comment"));
ok('verify.md: no "Post the result"', !verify.includes('Post the result'));
ok('verify.md keeps the three tokens', ['met', 'gaps_found', 'inconclusive'].every((t) => verify.includes(`\`status: ${t}\``)));
ok('code-review.md: returns the report and the orchestrator posts it as the VERIFY comment',
  /Return the report/.test(codeReview) && codeReview.includes('the orchestrator posts it as the `VERIFY` comment'));
ok('code-review.md: no "Report in the ticket\'s VERIFY comment"', !codeReview.includes("Report in the ticket's `VERIFY` comment"));
ok('code-review.md: status tag still on its own first line', codeReview.includes('machine-checkable status tag on its own first line'));
ok('code-review.md: counts line phrasing kept', codeReview.includes('critical: <n> · warning: <n> · info: <n>')
  && codeReview.includes('**Counts line, right under `status:`.**'));
ok('code-review.md: dispositions and the latest VERIFY comment kept',
  codeReview.includes('`fixed (<commit>)`') && codeReview.includes('latest `VERIFY` comment'));
ok('code-review.md keeps the #181 Ticket diff rule', codeReview.includes("**Ticket diff: review the ticket's own commits, never a range.**"));

// --- acceptance results are part 3 of the round's single VERIFY comment ---------------
ok('acceptance-testing.md: results are gathered as it goes and land in part 3 of the round\'s VERIFY comment',
  acceptance.includes('as it goes') && acceptance.includes("part 3 of the round's single `VERIFY` comment"));
ok('acceptance-testing.md: the orchestrator posts once the round\'s checks, including acceptance, are done',
  acceptance.includes('the orchestrator posts once the round\'s checks, including this one, are done'));
ok('acceptance-testing.md: no longer records "in the VERIFY comment as it goes"', !acceptance.includes('in the `VERIFY` comment as it goes'));
ok('acceptance-testing.md: the screenshot and the pending checklist go to part 3, not straight into a comment',
  !acceptance.includes('screenshot into the `VERIFY` comment') && !acceptance.includes('checklist in the `VERIFY` comment'));
ok('acceptance-testing.md: the two start paths outside a Verify round post their own VERIFY comment',
  acceptance.includes("the Pending-UAT guard's option (a) and a UAT follow-up, there is no round: the orchestrator posts the results as a `VERIFY` comment of their own"));
ok('acceptance-testing.md: no em-dash', !acceptance.includes('\u2014'));

// --- every engine step reads the fields of its agent's report (#249) --------------------
const stepOf = (src, startPrefix, endPrefix) => {
  const ls = src.split('\n');
  const a = ls.findIndex((l) => l.startsWith(startPrefix));
  const b = ls.findIndex((l, i) => i > a && l.startsWith(endPrefix));
  return a === -1 ? '' : ls.slice(a, b === -1 ? undefined : b).join('\n');
};
const has = (src, ...needles) => needles.every((n) => src.includes(n));
const plan = stepOf(engines, '2. **Plan**', '3. **Execute**');
const execute = stepOf(engines, '3. **Execute**', '4. **Verify**');
const fixStep = stepOf(engines, '3. **Fix**', '4. **Verify**');
const diagnose = stepOf(engines, '2. **Diagnose**', '3. **Fix**');
ok('the steps were found', [plan, execute, fixStep, diagnose].every((x) => x.length > 300));
ok('Plan: checks the planner report with --technique plan', has(plan, '--technique plan', '*Malformed review report*'));
ok('Plan: ready posts the checker body verbatim as the PLAN comment', has(plan, '`status: ready`', "checker's `body` verbatim", '`PLAN` comment'));
ok('Plan: needs_input asks the questions, re-spawns with the answers, never guesses',
  has(plan, '`status: needs_input`', '`questions:`', 're-spawn the planner with the answers', 'never answer them yourself or guess'));
for (const [label, step, tech] of [['Execute', execute, 'executor'], ['Fix', fixStep, 'fix']]) {
  ok(`${label}: checks the report with --technique ${tech}`, has(step, `--technique ${tech}`, '*Malformed review report*'));
  ok(`${label}: branches on the verdict and reads the fields, never reconstructs from prose`,
    has(step, "checker's `verdict`", '`fields`', 'never reconstruct a result from the prose'));
  ok(`${label}: done goes to Verify`, has(step, '`status: done` -> Verify'));
  ok(`${label}: partial or blocked acts on each blockers entry, then re-spawns`,
    has(step, '`status: partial` or `blocked`', 'each `blockers:` entry', 'foreign change', 're-spawn'));
  ok(`${label}: posts fidelity as the fidelity comment and routes surfaced scope`, has(step, 'Post `fidelity:` as the fidelity comment', '`surfaced scope:`'));
  ok(`${label}: commits must equal the Refs set since the base, both directions, every SHA resolves, a mismatch is surfaced`,
    has(step, '`commits:`', 'must equal the `Refs: #<n>` commit set since the base SHA', 'both directions', 'every SHA must resolve', 'surfaced to the user, never patched over'));
}
ok('Diagnose: checks the debug report with --technique debug', has(diagnose, '--technique debug', '*Malformed review report*'));
ok('Diagnose: found feeds the DIAGNOSIS from answer and evidence', has(diagnose, '`status: found`', '`answer:`', '`evidence:`', '`DIAGNOSIS`'));
ok('Diagnose: inconclusive stays in diagnosis, needs_input asks the open questions',
  has(diagnose, '`status: inconclusive`', 'stays in diagnosis', '`status: needs_input`', '`open questions:`'));
ok('research: no research/<name> branch anywhere', ![research, charting, researchAgent].some((t) => /research\/(<name>|&lt;name)/.test(t)));
ok('research: the report is the artifact, posted as a RESEARCH comment with every claim and its URL',
  has(research, 'the report is the artifact', '`RESEARCH` comment', '`evidence:`', 'URL'));
ok('research: branches on found, inconclusive and needs_input',
  has(research, '`status: found`', 'resolve the ticket', '`status: inconclusive`', 'accept the answer at that confidence, narrow the question, or run another round',
    '`status: needs_input`', '`open questions:`', 're-spawn'));
ok('research: checked with --technique research', research.includes('--technique research'));
ok('charting: the research fan-out posts the report, no branch', has(charting, '`RESEARCH` comment', 'no branch'));
ok('research agent: identity returns findings in the report', researchAgent.includes('returning findings with their citations in your report') && researchAgent.includes('commit nothing'));
ok('codebase-map: each reader returns an investigating report checked with --technique codebase-map',
  has(codebaseMap, 'investigating report', '--technique codebase-map'));
ok('codebase-map: distils the answer fields; inconclusive notes the gap; needs_input asked once then re-spawned or unmapped',
  has(codebaseMap, 'distil** the `answer:` fields', '`status: inconclusive`', 'note the gap', '`status: needs_input`', 'once', 're-spawn that facet', 'unmapped'));
ok('debug: a Report line points at the investigating contract', has(debug, '**Report.**', 'investigating report', 'never commits or creates a branch', '`DIAGNOSIS`'));
ok('brief: the report names the implementing Return contract', has(brief, 'implementing `Return contract`', '`blockers:`'));

for (const [label, src] of [['techniques.md', techniques], ['verify.md', verify], ['code-review.md', codeReview], ['ticket-engines.md', engines], ['executor-brief.md', brief], ['research.md', research], ['codebase-map.md', codebaseMap], ['debug.md', debug], ['charting.md', charting]]) {
  ok(`${label}: no em-dash`, !src.includes('—'));
}

console.log(`report-status-docs.test.js: ${passed} checks passed`);
