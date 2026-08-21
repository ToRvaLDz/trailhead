'use strict';
// commit-message-check.js: the single source of truth for trailhead's commit
// message rules, shared by two guardrails so they can never drift:
//   - trailhead-commit-guard.js         (Claude Code PreToolUse(Bash) hook)
//   - templates/trailhead-commit-msg    (host-independent git commit-msg hook,
//     installed into .git/hooks at repo first-use so it runs on ANY host)
// Two rules: NEVER a Co-Authored-By trailer; a Conventional Commits subject
// (<type>(scope)?: subject) of at most 72 chars.
// Pure and dependency-free: takes a commit message string, returns a verdict.

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
const CONVENTIONAL = new RegExp(`^(${TYPES})(\\([^)]+\\))?!?:\\s.+`);
const CO_AUTHORED = /co-authored-by\s*:/i;
const SCISSORS = '# ------------------------ >8';

// The message region: everything before git's --verbose scissors line (the
// block after it is the diff, not the message). Everything else is kept, so a
// Co-Authored-By hiding in a body/comment line is still caught.
function messageRegion(raw) {
  const text = String(raw == null ? '' : raw);
  const i = text.indexOf(SCISSORS);
  return i === -1 ? text : text.slice(0, i);
}

// Subject = first non-empty, non-comment (`#`) line of the message region,
// mirroring how git itself derives the subject from a commit-message file.
function subjectOf(raw) {
  for (const line of messageRegion(raw).split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    return line.trim();
  }
  return '';
}

// checkCommitMessage(message) -> { ok: true } | { ok: false, code, reason }
function checkCommitMessage(message) {
  const region = messageRegion(message);

  if (CO_AUTHORED.test(region)) {
    return {
      ok: false,
      code: 'CO_AUTHORED_BY_FORBIDDEN',
      reason: 'trailhead: do not add a Co-Authored-By trailer to commits. Remove it and commit again.',
    };
  }

  const subject = subjectOf(message);
  if (subject && !CONVENTIONAL.test(subject)) {
    return {
      ok: false,
      code: 'CONVENTIONAL_COMMITS_VIOLATION',
      reason: `trailhead: commit subject must be Conventional Commits: <type>(<scope>)?: <subject>. Valid types: ${TYPES.replace(/\|/g, ', ')}.`,
    };
  }
  if (subject.length > 72) {
    return {
      ok: false,
      code: 'COMMIT_SUBJECT_TOO_LONG',
      reason: 'trailhead: commit subject must be 72 characters or less.',
    };
  }
  return { ok: true };
}

module.exports = { checkCommitMessage, subjectOf, messageRegion, TYPES, CONVENTIONAL, CO_AUTHORED };
