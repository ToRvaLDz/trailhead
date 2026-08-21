#!/usr/bin/env node
// Tests for commit-message-check.js. Run: node commit-message-check.test.js
// No framework: plain asserts, mirrors the style of trailhead-secret-guard.test.js.
//
// Drives the SAME fixtures through two paths:
//   1. checkCommitMessage() directly (the source of truth).
//   2. the template hook (templates/trailhead-commit-msg) end-to-end via
//      execFileSync, feeding it the message as a temp file.
// The two verdicts must always agree: that agreement is the anti-drift
// guarantee that keeps the Claude Code hook and the git commit-msg hook from
// ever diverging.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { checkCommitMessage } = require('./commit-message-check.js');

const templatePath = path.resolve(__dirname, '..', '..', 'templates', 'trailhead-commit-msg');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const FIXTURES = [
  { name: 'valid subject', message: 'feat: add thing', expectOk: true },
  { name: 'valid with scope and body', message: 'fix(installer): x\n\nbody line', expectOk: true },
  { name: 'non-conventional subject', message: 'add thing', expectOk: false, code: 'CONVENTIONAL_COMMITS_VIOLATION' },
  { name: 'subject too long', message: 'feat: ' + 'x'.repeat(70), expectOk: false, code: 'COMMIT_SUBJECT_TOO_LONG' },
  { name: 'co-authored anywhere', message: 'feat: x\n\nCo-authored-by: A <a@b.c>', expectOk: false, code: 'CO_AUTHORED_BY_FORBIDDEN' },
  { name: 'leading git comment lines then valid subject', message: '# comment\n\nfeat: x', expectOk: true },
  {
    name: 'verbose scissors: co-authored past the scissors is ignored',
    message: 'feat: x\n\n# ------------------------ >8 ------------------------\ndiff with Co-authored-by: junk',
    expectOk: true,
  },
  { name: 'empty message', message: '', expectOk: true },
];

// --- unit: checkCommitMessage() directly ---
for (const f of FIXTURES) {
  const verdict = checkCommitMessage(f.message);
  ok(`checkCommitMessage: ${f.name} -> ok=${f.expectOk}`, verdict.ok === f.expectOk);
  if (!f.expectOk && f.code) {
    ok(`checkCommitMessage: ${f.name} -> code=${f.code}`, verdict.code === f.code);
  }
}

// --- end-to-end: drive the template hook on the SAME fixtures ---
function runTemplateHook(message) {
  const tmpFile = path.join(os.tmpdir(), `trailhead-commit-msg-test-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmpFile, message);
  try {
    execFileSync('node', [templatePath, tmpFile]);
    return true; // exit 0 -> allow
  } catch {
    return false; // non-zero exit -> block
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

for (const f of FIXTURES) {
  const allowed = runTemplateHook(f.message);
  const expected = checkCommitMessage(f.message).ok;
  ok(`template hook: ${f.name} -> allowed=${expected}`, allowed === expected);
}

// --- stripComments seam: the `-m` guard path (stripComments:false) must NOT
// treat a `#`-leading subject as a comment (git -m keeps `#` lines as text),
// while the default file-semantics path (strip=true) does. Regression guard for
// the parity gap the code review caught. ---
const hashSubject = '#123 wip do stuff';
ok('no-strip: #-leading subject is a real (non-conventional) subject -> block',
  checkCommitMessage(hashSubject, { stripComments: false }).ok === false);
ok('no-strip: #-leading subject blocks with the conventional code',
  checkCommitMessage(hashSubject, { stripComments: false }).code === 'CONVENTIONAL_COMMITS_VIOLATION');
ok('default strip: #-leading line is a comment -> empty subject -> allow',
  checkCommitMessage(hashSubject).ok === true);
ok('template hook: #-leading message is file-semantics (comment) -> allow',
  runTemplateHook(hashSubject) === true);

console.log(`✓ commit-message-check: ${passed} assertions passed`);
