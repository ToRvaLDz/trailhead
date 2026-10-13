#!/usr/bin/env node
// trailhead-commit-guard.js: PreToolUse(Bash) hook.
// Enforces trailhead's commit discipline on `git commit`:
//   1. NEVER a Co-Authored-By trailer.
//   2. Conventional Commits subject: <type>(<scope>)?: <subject>, <=72 chars.
// Blocks with exit 2 + {"decision":"block","reason":...}; allows everything else.
// Crash-safe: any error → exit 0 (never wedge the user's workflow).
// Self-contained, no dependencies. Exports a pure evaluate(cmd) so the merged
// trailhead-bash-guards.js can run it in-process; run directly it is unchanged.

const { checkCommitMessage } = require('./lib/commit-message-check.js');

const CO_AUTHORED = /co-authored-by\s*:/i;

const ALLOW = { kind: 'allow' };

function blockVerdict(code, reason) {
  return { kind: 'block', payload: { decision: 'block', code, reason } };
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

// Pure verdict for one command: {kind:'allow'} or {kind:'block', payload}. Never
// exits or writes; any internal error falls through to allow (crash-safe).
function evaluate(cmd) {
  try {
    if (!isGitCommit(cmd)) return ALLOW;

    // Co-Authored-By anywhere in the command (covers -m, -F, heredocs).
    if (CO_AUTHORED.test(cmd)) {
      return blockVerdict('CO_AUTHORED_BY_FORBIDDEN',
        'trailhead: do not add a Co-Authored-By trailer to commits. Remove it and commit again.');
    }

    const msg = extractMessage(cmd);
    if (msg) {
      // stripComments:false, this is the literal `-m` value, where git keeps
      // `#` lines as message text (cleanup=whitespace), so a `#…` first line is
      // a real subject to validate, not a comment to skip.
      const verdict = checkCommitMessage(msg, { stripComments: false });
      if (!verdict.ok) return blockVerdict(verdict.code, verdict.reason);
    }
  } catch {
    // fall through to allow
  }
  return ALLOW;
}

// Standalone CLI: write the payload and exit exactly as the guard always did.
function run(data) {
  let cmd = '';
  try {
    cmd = (JSON.parse(data).tool_input || {}).command || '';
  } catch {
    process.exit(0);
  }
  const v = evaluate(cmd);
  if (v.kind === 'block') {
    process.stdout.write(JSON.stringify(v.payload));
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000);
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { evaluate };
