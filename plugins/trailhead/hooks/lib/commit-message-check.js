'use strict';
// commit-message-check.js: the single source of truth for trailhead's commit
// message rules, shared by two guardrails so they can never drift:
//   - trailhead-commit-guard.js         (Claude Code PreToolUse(Bash) hook)
//   - templates/trailhead-commit-msg    (host-independent git commit-msg hook,
//     installed into .git/hooks at repo first-use so it runs on ANY host)
// Two rules: NEVER a Co-Authored-By trailer; a Conventional Commits subject
// (<type>(scope)?: subject) of at most 72 chars. Plus a conditional third rule:
// while a ticket is active (a caller passes opts.ticket, resolved from the
// .trailhead/session-ticket marker), the message must carry a matching
// `Refs: #<n>` trailer, so every commit made while resolving a ticket threads
// into that ticket's timeline.
// Pure and dependency-free: takes a commit message string, returns a verdict.

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
const CONVENTIONAL = new RegExp(`^(${TYPES})(\\([^)]+\\))?!?:\\s.+`);
const CO_AUTHORED = /co-authored-by\s*:/i;
const SCISSORS = '# ------------------------ >8';
const REFS_LINE = /^\s*refs\s*:(.*)$/i;

// The message region: everything before git's --verbose scissors line (the
// block after it is the diff, not the message). Everything else is kept, so a
// Co-Authored-By hiding in a body/comment line is still caught.
function messageRegion(raw) {
  const text = String(raw == null ? '' : raw);
  const i = text.indexOf(SCISSORS);
  return i === -1 ? text : text.slice(0, i);
}

// Subject = first non-empty line of the message region. `opts.stripComments`
// (default true) also skips git comment (`#`) lines: correct for a commit-msg
// FILE, where git has not yet stripped its `#` boilerplate. It must be FALSE
// for a `git commit -m` string, where cleanup=whitespace keeps `#` lines as
// literal message text, so `#123 wip` is a real (non-conventional) subject and
// must NOT be treated as a comment. This is the seam the PreToolUse guard and
// the git hook diverge at (decision #16 defence in depth).
function subjectOf(raw, opts = {}) {
  const stripComments = opts.stripComments !== false;
  for (const line of messageRegion(raw).split('\n')) {
    if (line.trim() === '') continue;
    if (stripComments && line.startsWith('#')) continue;
    return line.trim();
  }
  return '';
}

// parseSessionTicket(text) -> ticket number | null
// Parses the first line of a .trailhead/session-ticket marker (`#<n> <title>`).
// Strips a leading BOM and any trailing \r before matching, so a marker read
// with either line-ending convention parses the same way. Anything else
// (empty text, no leading '#', a non-digit, a leading zero, or trailing
// characters glued to the digits) is not a valid marker and yields null.
function parseSessionTicket(text) {
  const raw = String(text == null ? '' : text).replace(/^﻿/, '');
  const firstLine = raw.split('\n')[0].replace(/\r$/, '');
  const m = firstLine.match(/^#([1-9]\d*)(?:\s|$)/);
  return m ? Number(m[1]) : null;
}

// hasRefsFor(message, n, opts?) -> boolean
// Scans the message region (see messageRegion) for a `Refs:` trailer line
// whose value contains `#<n>` not immediately followed by another word
// character (so `#184` matches but `#18` and `#184abc` do not). By default
// `#`-leading git comment lines are skipped (file semantics); pass
// `opts.stripComments: false` to also count a Refs trailer inside a comment
// line (used when validating a literal `-m` string, where `#` is not a
// comment marker).
function hasRefsFor(message, n, opts = {}) {
  const stripComments = opts.stripComments !== false;
  const target = new RegExp('#' + n + '(?![\\w])');
  for (const line of messageRegion(message).split('\n')) {
    if (stripComments && line.trim().startsWith('#')) continue;
    const m = line.match(REFS_LINE);
    if (m && target.test(m[1])) return true;
  }
  return false;
}

// checkCommitMessage(message, opts?) -> { ok: true } | { ok: false, code, reason }
// opts.stripComments is forwarded to subjectOf (see there): the git commit-msg
// hook uses the default (file semantics); the PreToolUse `-m` guard passes false.
// opts.ticket activates the Refs rule when it is a positive integer (the
// ticket resolved from a live .trailhead/session-ticket marker); any other
// value (undefined, a non-integer, a string, 0, negative) leaves the rule off,
// it never blocks by mistake. When active it applies even to an empty
// message, closing a `--allow-empty-message` bypass.
function checkCommitMessage(message, opts = {}) {
  const region = messageRegion(message);
  const ticketActive = Number.isInteger(opts.ticket) && opts.ticket > 0;

  if (CO_AUTHORED.test(region)) {
    return {
      ok: false,
      code: 'CO_AUTHORED_BY_FORBIDDEN',
      reason: 'trailhead: do not add a Co-Authored-By trailer to commits. Remove it and commit again.',
    };
  }

  const subject = subjectOf(message, opts);
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
  if (ticketActive && !hasRefsFor(message, opts.ticket, opts)) {
    return {
      ok: false,
      code: 'REFS_TRAILER_MISSING',
      reason: `trailhead: this commit is on ticket #${opts.ticket} (per .trailhead/session-ticket) but has no "Refs: #${opts.ticket}" trailer. Add "Refs: #${opts.ticket}" as the last line of the message and commit again. If this commit is not part of ticket #${opts.ticket}, remove the stale .trailhead/session-ticket marker first.`,
    };
  }
  return { ok: true };
}

module.exports = {
  checkCommitMessage,
  subjectOf,
  messageRegion,
  parseSessionTicket,
  hasRefsFor,
  TYPES,
  CONVENTIONAL,
  CO_AUTHORED,
};
