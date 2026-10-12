#!/usr/bin/env node
// Tests for unmodelled.js. Run: node unmodelled.test.js
const assert = require('assert');
const { findUnmodelled, firstRelevant, unmodelledReason, UNMODELLED } = require('./unmodelled.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const ids = (cmd) => findUnmodelled(cmd).map((h) => h.id);
const has = (cmd, id) => ids(cmd).includes(id);
const none = (cmd) => ids(cmd).length === 0;
// A stand-in write classifier: the lib has none of its own, each guard passes its own.
const isWrite = (t) => /\bgh\s+(?:issue|pr)\s+(?:comment|edit|create)\b/.test(t);
const relevant = (cmd) => !!firstRelevant(findUnmodelled(cmd), isWrite);

// --- the closed table ---
ok('UNMODELLED lists every construct with a label and a hint', ['eval', 'source', 'funsub', 'printf-v', 'function', 'alias', 'api-field', 'continuation']
  .every((id) => UNMODELLED[id] && UNMODELLED[id].label && UNMODELLED[id].hint));

// --- eval ---
ok('eval is detected', has('eval "$(ssh-agent)"', 'eval'));
ok('eval payload is its quote-removed arguments', findUnmodelled("eval 'gh issue comment 1 --body x'")[0].payload === 'gh issue comment 1 --body x');
ok('eval behind a wrapper is detected', has('command eval x', 'eval') && has('FOO=1 eval x', 'eval'));
ok('eval after && is detected', has('true && eval x', 'eval'));
ok('eval in quoted prose is not', none("gh issue comment 1 --body 'use eval here'"));
ok('eval as an argument is not', none('echo eval'));
ok('eval in a comment is not', none('echo hi # eval x'));

// --- source ---
ok('source is detected', has('source ./post.sh', 'source'));
ok('. is detected', has('. ./post.sh', 'source'));
ok('. inside quotes is not', none('echo ". x"'));
ok('./script is not', none('./post.sh'));
ok('source as an argument is not', none('echo source x'));

// --- function substitution ---
ok('${ cmd; } is detected', has('echo ${ gh issue comment 1 --body x; }', 'funsub'));
ok('${| cmd; } is detected', has('echo ${| REPLY=x; }', 'funsub'));
ok('${<newline> is detected', has('echo ${\ndate\n}', 'funsub'));
ok('funsub payload is the body', findUnmodelled('echo ${ date; }')[0].payload === ' date; ');
ok('plain expansions are not', none('echo ${x} ${x:-y}'));
ok('a single-quoted funsub is not', none("echo '${ x; }'"));
ok('a funsub inside a $(..) body is found', has('echo $(echo ${ date; })', 'funsub'));
ok('a funsub inside a backtick body is found', has('echo `echo ${ date; }`', 'funsub'));
ok('a funsub in an unquoted heredoc is found', has('cat <<E\n${ date; }\nE', 'funsub'));

// --- printf -v ---
ok('printf -v is detected', has('printf -v B %s x', 'printf-v'));
ok('printf -vNAME is detected', has('printf -vB %s x', 'printf-v'));
ok('printf without -v is not', none("printf '%s' x"));
ok('a -v after the format is not', none('printf %s -v'));

// --- function definitions ---
ok('name() { is detected', has('f(){ :; }', 'function'));
ok('name () is detected', has('f () { :; }', 'function'));
ok('function name is detected', has('function f { :; }', 'function'));
ok('a function head after a leader is detected', has('true && f() { :; }', 'function'));
ok('f() in quotes is not', none('echo "f()"') && none('git commit -m "f() {"'));
ok('function name and body are reported', (() => {
  const h = findUnmodelled('f() { gh issue comment 1 --body x; }; f')[0];
  return h.id === 'function' && h.name === 'f' && /gh issue comment/.test(h.payload) && h.calls.length === 1;
})());
ok('a multi-line function body is the payload', /gh issue comment/.test(findUnmodelled('f() {\n  ls\n  gh issue comment 1 --body x\n}\nf')[0].payload));

// --- alias ---
ok('alias is detected', has('alias a=b', 'alias'));
ok('alias in prose is not', none('echo alias'));
ok('alias name and value are reported', (() => {
  const h = findUnmodelled('alias g=gh; g issue list')[0];
  return h.name === 'g' && h.payload === 'gh' && h.calls.length === 1 && h.calls[0] === 'gh issue list';
})());

// --- gh api body field ---
ok("-f 'body'= is detected", has("gh api -X PATCH repos/o/r/issues/1 -f 'body'=\"\"", 'api-field'));
ok('-f bo""dy= is detected', has('gh api -X PATCH repos/o/r/issues/1 -f bo""dy=""', 'api-field'));
ok('-f b\\ody= is detected', has('gh api repos/o/r/issues/1 -f b\\ody=x', 'api-field'));
ok('--field "body"= is detected', has('gh api repos/o/r/issues/1 --field "body"=x', 'api-field'));
ok('--raw-field=bo""dy=x is detected', has('gh api repos/o/r/issues/1 --raw-field=bo""dy=x', 'api-field'));
ok('-Fb\'ody\'=x glued is detected', has("gh api repos/o/r/issues/1 -F'body'=x", 'api-field'));
ok('-f body=x is plain', none('gh api repos/o/r/issues/1 -f body=x'));
ok('-f "body=x" is plain', none('gh api repos/o/r/issues/1 -f "body=x"'));
ok("-f 'body=x' is plain", none("gh api repos/o/r/issues/1 -f 'body=x'"));
ok('-f "body=say \\"hi\\"" is plain', none('gh api repos/o/r/issues/1 -f "body=say \\"hi\\""'));
ok('-F title=x is plain', none('gh api repos/o/r/issues/1 -F title=x'));
ok('-f "title"=x is plain', none('gh api repos/o/r/issues/1 -f "title"=x'));
ok('a non-api gh statement is not', none('gh issue comment 1 --body "bo""dy=x"'));

// --- in-word continuation ---
ok('cat .e\\<nl>nv is detected', has('cat .e\\\nnv', 'continuation'));
ok('a continuation between words is not', none('gh issue comment 1 \\\n  --body x'));
ok('a single-quoted continuation is not', none("echo 'a\\\nb'"));

// --- statement bookkeeping ---
ok('a hit carries its statement and index', (() => {
  const h = findUnmodelled('echo a; source f; echo b')[0];
  return h.stmt === 'source f' && h.stmtIndex === 1 && h.after === 'echo b';
})());
ok('the sample is the compacted statement', findUnmodelled('echo a\nsource f')[0].sample === 'source f');
ok('a hit inside a $(..) is found with its own statements', has('x=$(source f; gh issue comment 1 --body y)', 'source'));
ok('a hit inside a quoted heredoc body is not', none("cat <<'E'\neval x\nsource y\nE"));
ok('a hit inside an unquoted heredoc $(..) is found', has('cat <<E\n$(source f)\nE', 'source'));

// --- relevance: payload constructs ---
ok('eval with a write payload is relevant', relevant("eval 'gh issue comment 1 --body x'"));
ok('eval "$(ssh-agent)" next to a write is not', !relevant('eval "$(ssh-agent)"; gh issue comment 1 --body-file /tmp/clean.md'));
ok('eval alone is not', !relevant('eval "$(ssh-agent)"'));
ok('funsub with a write payload is relevant', relevant('echo ${ gh issue comment 1 --body-file /tmp/f; }'));
ok('funsub without a write payload is not', !relevant('echo ${ date; }; gh issue comment 1 --body-file /tmp/clean.md'));
ok('a called function with a write body is relevant', relevant('f() { gh issue comment 1 --body x; }; f'));
ok('an uncalled function with a write body is not', !relevant('f() { gh issue comment 1 --body x; }'));
ok('a called function without a write body next to a write is not', !relevant('f(){ ls; }; f; gh issue comment 1 --body-file /tmp/clean.md'));
ok('a function called through a substitution is relevant', relevant('f() { gh issue comment 1 --body x; }; x=$(f)'));
ok('alias g=gh then g issue comment is relevant', relevant('alias g=gh; g issue comment 1 --body x'));
ok('alias g=gh alone is not', !relevant('alias g=gh'));
ok('alias g=gh then a read-only call is not', !relevant('alias g=gh; g issue list'));
ok("alias ll='ls -l' next to a write is not", !relevant("alias ll='ls -l'; gh issue comment 1 --body-file /tmp/clean.md"));
ok('a write quoted in prose next to an alias is not', !relevant('echo "gh issue edit 1"; alias ll=ls'));

// --- relevance: state constructs ---
ok('source before a write is relevant', relevant('source ./post.sh; gh issue comment 1 --body-file /tmp/clean.md'));
ok('source after the write is not', !relevant('gh issue comment 1 --body-file /tmp/clean.md; source ./post.sh'));
ok('source with no write is not', !relevant('source ~/.venv/bin/activate && pytest'));
ok('printf -v before a write is relevant', relevant('printf -v B %s x; gh issue comment 1 --body "$B"'));
ok('printf -v after the write is not', !relevant('gh issue comment 1 --body-file /tmp/clean.md; printf -v B %s x'));
ok('printf -v with no write is not', !relevant('printf -v x %s y; echo $x'));

// --- relevance: statement-local constructs ---
ok('a quoted api field is always relevant', relevant("gh api -X PATCH repos/o/r/issues/1 -f 'body'=\"\""));
ok('an in-word continuation in a write is relevant', relevant('gh issue com\\\nment 1 --body x'));
ok('an in-word continuation outside a write is not', !relevant('cat .e\\\nnv; gh issue comment 1 --body-file /tmp/clean.md'));
ok('an in-word continuation in a piped write is relevant', relevant('cat .e\\\nnv | gh issue comment 1 --body-file -'));

// --- the message ---
{
  const hit = findUnmodelled('eval "gh issue comment 1 --body ghp_' + 'a'.repeat(36) + '"')[0];
  const redact = (t) => t.replace(/ghp_[A-Za-z0-9]+/g, '<REDACTED>');
  const msg = unmodelledReason('secret-guard', 'the body it posts is secret-free', hit, redact);
  ok('the message names the guard, the construct and the rewrite', /^trailhead secret-guard: this command uses /.test(msg) && /Rewrite it in a simple form: /.test(msg) && msg.includes(UNMODELLED.eval.label));
  ok('the message never echoes a token', !msg.includes('ghp_'));
  ok('the sample is truncated to 80 chars', unmodelledReason('g', 'w', { ...hit, sample: 'x'.repeat(200) }, (t) => t).match(/`(x+)`/)[1].length === 80);
  ok('without a redactor the sample is withheld', !/ghp_/.test(unmodelledReason('g', 'w', hit)));
}

console.log(`✓ unmodelled: ${passed} assertions passed`);
