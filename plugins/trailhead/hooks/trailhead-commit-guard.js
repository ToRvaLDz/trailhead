#!/usr/bin/env node
// trailhead-commit-guard.js: PreToolUse(Bash) hook.
// Enforces trailhead's commit discipline on `git commit`:
//   1. NEVER a Co-Authored-By trailer.
//   2. Conventional Commits subject: <type>(<scope>)?: <subject>, <=72 chars.
// Blocks with exit 2 + {"decision":"block","reason":...}; allows everything else.
// Crash-safe: any error → exit 0 (never wedge the user's workflow).
// Self-contained, no dependencies.

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
const CONVENTIONAL = new RegExp(`^(${TYPES})(\\([^)]+\\))?!?:\\s.+`);
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

function extractMessage(cmd) {
  // -m "…" / -m '…' / -m token / --message=…
  let m = cmd.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(["'])([\s\S]*?)\1/);
  if (m) return m[2];
  m = cmd.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(\S+)/);
  return m ? m[1] : null;
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
      const subject = msg.split('\n')[0].trim();
      if (!CONVENTIONAL.test(subject)) {
        block('CONVENTIONAL_COMMITS_VIOLATION',
          `trailhead: commit subject must be Conventional Commits: <type>(<scope>)?: <subject>. Valid types: ${TYPES.replace(/\|/g, ', ')}.`);
      }
      if (subject.length > 72) {
        block('COMMIT_SUBJECT_TOO_LONG', 'trailhead: commit subject must be 72 characters or less.');
      }
    }
  } catch {
    // fall through to allow
  }
  process.exit(0);
});
