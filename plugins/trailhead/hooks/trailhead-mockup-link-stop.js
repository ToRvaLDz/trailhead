#!/usr/bin/env node
// trailhead-mockup-link-stop.js: Stop hook (Codex).
// Codex twin of trailhead-mockup-link-guard.js. On Codex trailhead asks its
// questions as a plain-text numbered list (request_user_input is Plan-Mode
// only), so there is no tool call to gate: this hook reads the final reply
// (`last_assistant_message`) instead. When the reply asks to approve a mockup
// (or pick between mockup variants) and carries no URL or file path, it
// answers {"decision":"block","reason":...}: on Stop, Codex does not reject
// the turn but continues it, with the reason as the next prompt, so the agent
// rewrites the ask with the link.
// Never blocks a turn that was already continued (`stop_hook_active`), so it
// cannot loop. Fail-OPEN on any error (exit 0, no output).

const { hasLink, isMockupApprovalMessage, BLOCK_REASON } = require('./lib/mockup-link.js');

function run(data) {
  try {
    const payload = JSON.parse(data);
    if (payload.stop_hook_active) process.exit(0);
    const msg = payload.last_assistant_message;
    if (isMockupApprovalMessage(msg) && !hasLink(msg)) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: BLOCK_REASON }));
    }
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
