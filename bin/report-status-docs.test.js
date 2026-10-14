#!/usr/bin/env node
// Pins the review report status protocol in the shipped skills (#250): the
// canonical "Malformed review report" paragraph and VERIFY comment layout in
// _shared/techniques.md, the clause on both Verify lines of ticket-engines.md,
// and the return-not-post wording in the verify and code-review techniques.
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

// --- the canonical paragraph -------------------------------------------------------
const start = techniques.indexOf('**Malformed review report');
ok('techniques.md has the Malformed review report paragraph', start !== -1);
const neverBlock = techniques.indexOf('**Reviews never block the session');
ok('the paragraph sits next to "Reviews never block the session"',
  start !== -1 && neverBlock !== -1 && Math.abs(start - neverBlock) < 2500 && start > neverBlock);
const para = start === -1 ? '' : techniques.slice(start, techniques.indexOf('\n| Technique |', start));
const lc = para.toLowerCase();
ok('the paragraph section was found and is bounded', para.length > 1000 && !para.includes('| **Grilling**'));

ok('it MUST run on every Code review and Goal-backward verification report', /MUST run on every/.test(para)
  && para.includes('Code review') && para.includes('Goal-backward verification'));
ok('it covers subagent, inline and the lean inline pass', lc.includes('subagent') && lc.includes('inline') && lc.includes('lean inline pass'));
ok('the checker command with its technique flag and a report file',
  para.includes('node <templates>/trailhead-report-status.js --technique <verify|code-review> --file <that dir>/report.md'));
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
ok('reask: ask once, continue the same agent where the host allows, else re-dispatch',
  lc.includes('ask once') && lc.includes('continue the same agent') && lc.includes('re-dispatch the same `trailhead-<technique>` agent')
  && lc.includes('same model override') && lc.includes('malformed report quoted'));
const prompt = 'Your report could not be accepted: `<problem>` (missing: no `status:` line; unknown-token: `<found>` is not an allowed token; '
  + 'conflicting: more than one `status:` line with different tokens; counts: the counts line is missing or repeated). '
  + 'Return the complete report again with its first line exactly `status: <token>`, where `<token>` is one of `<allowed tokens>`, '
  + 'and no other `status:` line<for code-review: , and its second line exactly `critical: <n> · warning: <n> · info: <n>`>. '
  + 'Do not post it anywhere.';
ok('the corrective prompt, verbatim', para.includes(prompt));
ok('for code-review the prompt always restates both required lines', lc.includes('always restates both required lines'));
ok('the reply is re-checked', lc.includes('re-check'));
ok('a second failure: no verdict, nothing posted, no third ask, no inference from the body',
  lc.includes('no verdict') && lc.includes('nothing posted') && lc.includes('no third ask') && lc.includes('no inference from the body'));
ok('a second failure: HITL checkpoint naming the technique and the problem, Resolve stays blocked',
  para.includes('HITL checkpoint') && lc.includes('naming the technique and the problem') && lc.includes('resolve stays blocked'));
ok('the previous VERIFY comment stays latest', lc.includes('previous `verify` comment stays latest'));
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

for (const [label, src] of [['techniques.md', techniques], ['verify.md', verify], ['code-review.md', codeReview], ['ticket-engines.md', engines]]) {
  ok(`${label}: no em-dash`, !src.includes('—'));
}

console.log(`report-status-docs.test.js: ${passed} checks passed`);
