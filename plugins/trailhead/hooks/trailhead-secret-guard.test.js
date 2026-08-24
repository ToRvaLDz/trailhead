#!/usr/bin/env node
// Tests for trailhead-secret-guard.js. Run: node trailhead-secret-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK = path.join(__dirname, 'trailhead-secret-guard.js');
const { scan, ghIssueWrite, bodyFileText } = require('./trailhead-secret-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Run the hook end-to-end: pipe tool_input JSON on stdin, capture {code, out}.
function runHook(command, env = {}) {
  const input = JSON.stringify({ tool_input: { command } });
  try {
    const out = execFileSync('node', [HOOK], { input, env: { ...process.env, ...env } });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}

// --- unit: scan() ---
ok('scan flags a GitHub token', scan('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx') === 'GitHub token');
ok('scan flags a private key', /private key/.test(scan('-----BEGIN RSA PRIVATE KEY-----') || ''));
ok('scan flags a hardcoded password', /password/.test(scan('db password=Sup3rSecretPass99') || ''));
ok('scan passes a redaction', scan('token: <REDACTED>') === null);
ok('scan passes an env ref', scan('use $SUPABASE_KEY here') === null);
ok('scan passes clean prose', scan('tutto ok, 368 test verdi') === null);

// --- unit: ghIssueWrite() ---
ok('detects gh issue comment', ghIssueWrite('gh issue comment 5 --body "x"') === 'issue');
ok('detects gh pr create', ghIssueWrite('gh pr create --body "x"') === 'pr');
ok('detects gh api body=', ghIssueWrite('gh api repos/o/r/issues/5/comments -f body=x') === 'api');
ok('ignores gh issue view (read)', ghIssueWrite('gh issue view 5 --json body') === null);
ok('ignores non-gh commands', ghIssueWrite('echo ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx') === null);

// --- end-to-end: block ---
const b1 = runHook('gh issue comment 5 --body "t ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xx"');
ok('blocks an inline secret (exit 2)', b1.code === 2 && /"decision":"block"/.test(b1.out));

const b2 = runHook('gh api repos/o/r/issues/5/comments -f body=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dozjgNryP4J3jVmNHl0w5N');
ok('blocks a JWT via gh api (exit 2)', b2.code === 2 && /"decision":"block"/.test(b2.out));

// --- end-to-end: body-file ---
const leaky = path.join(os.tmpdir(), `sg-leaky-${process.pid}.md`);
fs.writeFileSync(leaky, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
const b3 = runHook(`gh issue comment 5 --body-file ${leaky}`);
ok('blocks a secret inside --body-file (exit 2)', b3.code === 2 && /AWS access key/.test(b3.out));
fs.unlinkSync(leaky);

// --- unit: bodyFileText() path extraction ---
// A bare path abutting a shell metacharacter in a compound command must NOT
// swallow the metacharacter into the filename (regression: `.md;` -> ENOENT).
{
  const leak = path.join(os.tmpdir(), `sg-meta-${process.pid}.md`);
  fs.writeFileSync(leak, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  ok('bare path stops at a trailing ; (compound command)',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`gh issue edit 5 --body-file ${leak}; echo done`)));
  ok('bare path stops at a trailing ) ',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`(gh issue edit 5 --body-file ${leak})`)));
  ok('bare path still works with a following && and space',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`gh issue edit 5 --body-file ${leak} && echo ok`)));
  // A quoted path keeps metacharacters verbatim (only the closing quote delimits).
  const quoted = path.join(os.tmpdir(), `sg;meta-${process.pid}.md`);
  fs.writeFileSync(quoted, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
  ok('quoted path keeps an inner ; in the filename',
    /AKIAIOSFODNN7EXAMPLE/.test(bodyFileText(`gh issue edit 5 --body-file "${quoted}"`)));
  fs.unlinkSync(leak);
  fs.unlinkSync(quoted);
}

// End-to-end: the compound-command shape that produced the spurious advisory
// must now scan and BLOCK the real secret in the body.
const leaky2 = path.join(os.tmpdir(), `sg-leaky2-${process.pid}.md`);
fs.writeFileSync(leaky2, 'Deploy: AKIAIOSFODNN7EXAMPLE\n');
const b4 = runHook(`gh issue edit 5 --body-file ${leaky2}; echo done`);
ok('blocks a secret in --body-file even in a compound command (exit 2)',
  b4.code === 2 && /AWS access key/.test(b4.out));
fs.unlinkSync(leaky2);

// --- end-to-end: allow ---
const a1 = runHook('gh issue comment 5 --body "tutto ok, 368 test verdi"');
ok('allows a clean write (exit 0, no output)', a1.code === 0 && a1.out.trim() === '');
const a2 = runHook('gh issue view 5 --json body'); // read, never scanned
ok('allows a read (exit 0)', a2.code === 0 && a2.out.trim() === '');

// --- THE FAILURE ARM: a scan we could not complete must be OBSERVABLE, not a silent pass ---
const f = runHook('gh issue comment 5 --body "anything"', { TRAILHEAD_SECRETGUARD_THROW: '1' });
ok('could-not-scan does not block (exit 0)', f.code === 0);
ok('could-not-scan is OBSERVABLE, not byte-identical to a clean pass',
  /could NOT complete its scan/.test(f.out) && f.out.trim() !== '');
// And it only fires on an identified write; a read that errors stays silent (nothing to say):
const f2 = runHook('gh issue view 5 --json body', { TRAILHEAD_SECRETGUARD_THROW: '1' });
ok('could-not-scan advisory does NOT fire on a read', f2.code === 0 && f2.out.trim() === '');

console.log(`✓ secret-guard: ${passed} assertions passed`);
