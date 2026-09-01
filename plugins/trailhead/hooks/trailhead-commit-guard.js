#!/usr/bin/env node
// trailhead-commit-guard.js: PreToolUse(Bash) hook.
// Enforces trailhead's commit discipline on `git commit`:
//   1. NEVER a Co-Authored-By trailer.
//   2. Conventional Commits subject: <type>(<scope>)?: <subject>, <=72 chars.
// Blocks with exit 2 + {"decision":"block","reason":...}; allows everything else.
// Crash-safe: any error → exit 0 (never wedge the user's workflow).
// Self-contained, no dependencies.

const { checkCommitMessage } = require('./lib/commit-message-check.js');

const CO_AUTHORED = /co-authored-by\s*:/i;

function block(code, reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', code, reason }));
  process.exit(2);
}

// Token-walk: is this shell string a `git commit …`? Handles env-var prefixes
// (FOO=bar git …), full-path git, and global flags (-C path, -c k=v, --git-dir=…).
function isGitCommit(cmd) {
  const toks = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // env prefix
  if (i >= toks.length || !/(^|\/)git$/.test(toks[i])) return false;       // the git binary
  i++;
  while (i < toks.length && toks[i].startsWith('-')) {                     // global flags
    if (/^-(C|c|-git-dir|-work-tree|-namespace)$/.test(toks[i]) && !toks[i].includes('=')) i++;
    i++;
  }
  return toks[i] === 'commit';
}

// $(...) and backticks are the two command-substitution syntaxes. Inside a
// double-quoted (or unquoted) value the shell expands them, so the text the
// regex captured is shell syntax, not the real message -> fail open, or we'd
// raise false positives on valid commits (#121). But a backslash-escaped
// `\$(` / `` \` `` (an EVEN count preceding the marker means it is NOT escaped;
// an ODD count means it is) is a LITERAL, fully-static message that must still
// be validated, so only an UNESCAPED marker triggers fail-open. Inside single
// quotes everything is literal, so the captured text is always the real message.
const UNEXPANDABLE = /(?:^|[^\\])(?:\\\\)*(?:\$\(|`)/;

function extractMessage(cmd) {
  // -m "…" / -m '…' / -m token / --message=…
  let m = cmd.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(["'])([\s\S]*?)\1/);
  if (m) return (m[1] === '"' && UNEXPANDABLE.test(m[2])) ? null : m[2];
  m = cmd.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(\S+)/);
  if (m) return UNEXPANDABLE.test(m[1]) ? null : m[1];
  return null;
}

let data = '';
const timer = setTimeout(() => process.exit(0), 5000);
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    const cmd = (JSON.parse(data).tool_input || {}).command || '';
    if (!isGitCommit(cmd)) process.exit(0);

    // Co-Authored-By anywhere in the command (covers -m, -F, heredocs).
    if (CO_AUTHORED.test(cmd)) {
      block('CO_AUTHORED_BY_FORBIDDEN',
        'trailhead: do not add a Co-Authored-By trailer to commits. Remove it and commit again.');
    }

    const msg = extractMessage(cmd);
    if (msg) {
      // stripComments:false, this is the literal `-m` value, where git keeps
      // `#` lines as message text (cleanup=whitespace), so a `#…` first line is
      // a real subject to validate, not a comment to skip.
      const verdict = checkCommitMessage(msg, { stripComments: false });
      if (!verdict.ok) block(verdict.code, verdict.reason);
    }
  } catch {
    // fall through to allow
  }
  process.exit(0);
});
