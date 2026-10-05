// mockup-link.js: shared detection for the mockup-link guards.
// Consumers: trailhead-mockup-link-guard.js (Claude Code, PreToolUse on
// AskUserQuestion) and trailhead-mockup-link-stop.js (Codex, Stop on the
// final reply, where an ask is a plain-text numbered list, not a tool call).
// Pure functions, no dependencies.

const MOCKUP_WORD = /mock-?ups?|prototip|prototype|wireframe/i;
// The ask itself, second person (IT + EN): "approvi", "do you approve",
// "accetti", "quale variante". Kept narrow on purpose: "il mockup approvato"
// (a past approval) and the "want mockups first?" offer are not asks.
const APPROVAL_WORD = /\bapprovi\b|\bapprove\b|\baccetti\b|\bquale variante\b|\bwhich variant\b/i;

const URL_RE = /https?:\/\/\S+/i;
const FILE_RE = /[\w~.\-/]+\.(?:html?|png|jpe?g|svg|webp|gif|pdf)\b/i;

function hasLink(prose) {
  return typeof prose === 'string' && (URL_RE.test(prose) || FILE_RE.test(prose));
}

// One question's question, header and option labels. Option descriptions are
// left out: an offer like "Prima un mockup — attendo approvazione" describes
// a future approval, it does not ask for one.
function questionText(q) {
  const labels = Array.isArray(q.options) ? q.options.map((o) => o && o.label) : [];
  return [q.question, q.header, ...labels].filter((s) => typeof s === 'string').join('\n');
}

// AskUserQuestion input: does any single question ask to approve a mockup?
function isMockupApprovalAsk(input) {
  const qs = (input && Array.isArray(input.questions)) ? input.questions : [];
  return qs.some((q) => {
    const t = q ? questionText(q) : '';
    return MOCKUP_WORD.test(t) && APPROVAL_WORD.test(t);
  });
}

// A plain-text reply (Codex): it talks about a mockup and one of its
// question lines (a line holding "?") asks for the approval.
function isMockupApprovalMessage(text) {
  if (typeof text !== 'string' || !MOCKUP_WORD.test(text)) return false;
  return text.split('\n').some((l) => l.includes('?') && APPROVAL_WORD.test(l));
}

const BLOCK_REASON =
  'trailhead mockup-link: this asks to approve/react to a mockup, but the message carries ' +
  'no link to it. Write each mockup\'s clickable link (URL or file path, one line per ' +
  'screen/variant) in the plain prose immediately before the question, not the project ' +
  'name, then ask again. See "Surface the mockup" in _shared/techniques/prototype.md.';

module.exports = { hasLink, isMockupApprovalAsk, isMockupApprovalMessage, BLOCK_REASON };
