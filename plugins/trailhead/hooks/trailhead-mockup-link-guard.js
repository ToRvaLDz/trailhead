#!/usr/bin/env node
// trailhead-mockup-link-guard.js: PreToolUse(AskUserQuestion) hook.
// Structural backstop for the Prototype technique's "surface the mockup" rule
// (_shared/techniques/prototype.md): a message that asks to approve, react to,
// or pick between mockups must carry each mockup's clickable link in its
// plain prose, right before the question. The prose rule alone was skipped in
// practice (an approval asked with only the project's name, no URL), so this
// hook blocks an AskUserQuestion that is a mockup-approval ask when the
// assistant prose immediately before it (no tool call in between) holds no
// URL or file path.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Fail-OPEN on any error (exit 0): a missing/unreadable transcript or an
// unexpected shape must never wedge the workflow.
// Claude-Code-specific (Codex has no AskUserQuestion tool; its twin there is
// trailhead-mockup-link-stop.js). Detection lives in lib/mockup-link.js.
// Pure functions are exported for tests; runs as a hook when executed directly.

const fs = require('fs');
const { hasLink, isMockupApprovalAsk, BLOCK_REASON } = require('./lib/mockup-link.js');

// Only the transcript tail matters: the prose sits right before the ask.
const TAIL_BYTES = 512 * 1024;

const blocksOf = (e) => (Array.isArray(e.message && e.message.content) ? e.message.content : []);
const isPendingAsk = (e) => e.type === 'assistant'
  && blocksOf(e).some((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion');

// The assistant prose right before the ask: walk the main-chain entries back
// from the end, skip the pending AskUserQuestion entries, and collect text
// blocks until anything else (a user turn, a tool result, another tool call).
function proseBeforeAsk(entries) {
  const main = entries.filter((e) => e && (e.type === 'assistant' || e.type === 'user') && !e.isSidechain);
  let i = main.length - 1;
  while (i >= 0 && isPendingAsk(main[i])) i--;
  const texts = [];
  for (; i >= 0; i--) {
    const e = main[i];
    if (e.type !== 'assistant') break;
    const blocks = blocksOf(e);
    if (blocks.some((b) => b.type === 'tool_use')) break;
    blocks.filter((b) => b.type === 'text').forEach((b) => texts.unshift(b.text || ''));
  }
  return texts.join('\n');
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Parse JSONL leniently: the first line of a tail read may be cut mid-record.
function parseEntries(text) {
  return text.split('\n').flatMap((l) => {
    try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; }
  });
}

function block() {
  process.stdout.write(JSON.stringify({ decision: 'block', code: 'MOCKUP_LINK_MISSING', reason: BLOCK_REASON }));
  process.exit(2);
}

function run(data) {
  try {
    const payload = JSON.parse(data);
    if (payload.tool_name && payload.tool_name !== 'AskUserQuestion') process.exit(0);
    if (!isMockupApprovalAsk(payload.tool_input)) process.exit(0);
    if (!payload.transcript_path) process.exit(0);
    const prose = proseBeforeAsk(parseEntries(readTail(payload.transcript_path)));
    if (!hasLink(prose)) block();
  } catch {
    // fall through to allow: a guard must never wedge the workflow
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends -> give up
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { isMockupApprovalAsk, hasLink, proseBeforeAsk };
