#!/usr/bin/env node
// trailhead-secret-guard.js: PreToolUse(Bash) hook.
// trailhead posts a lot to GitHub Issues/PRs (ticket bodies, engine comments,
// codebase/conventions issues, resolutions) while working on codebases that hold
// secrets. This is the outbound barrier: it scans what a `gh` write is about to
// post to an issue/PR/comment and BLOCKS if it looks like a secret is in it, so
// nothing sensitive lands on the tracker.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Fail-OPEN on error to keep the workflow moving, but the failure is made
// OBSERVABLE (an advisory), never byte-identical to a clean pass: once a write is
// identified, a scan error emits a "could-not-scan" advisory instead of silently
// allowing. (Anti-pattern: a guard whose failure looks exactly like a success.)
// Self-contained. Pure functions are exported for tests; runs as a hook when
// executed directly.

const fs = require('fs');

// High-confidence secret formats: a match here is almost never a false positive.
const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'OpenAI/Anthropic key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe live key', re: /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'JWT / Supabase key', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
];

// Assignment heuristic: a secret-named key set to a real-looking value.
const ASSIGN_RE =
  /\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|bearer|dsn|conn(?:ection)?[_-]?string)\b\s*[:=]\s*["']?([^\s"']{8,})/i;
// Values that are clearly NOT a real secret (placeholders, env refs, redactions).
const SAFE_VALUE =
  /^(?:\$|\$\{|<|\*{2,}|x{3,}|redacted|your[-_]|example|placeholder|dummy|test|todo|none|null|true|false|process\.env|import\.meta|os\.environ)/i;

// Is this a `gh` command that WRITES issue/PR/comment text? Returns the kind or null.
function ghIssueWrite(cmd) {
  const toks = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // env prefix
  if (i >= toks.length || !/(^|\/)gh$/.test(toks[i])) return null;         // the gh binary
  const sub = toks[i + 1];
  const verb = toks[i + 2];
  if ((sub === 'issue' || sub === 'pr') && ['create', 'comment', 'edit', 'review'].includes(verb)) {
    return sub;
  }
  if (sub === 'api' && /(?:^|\s)(?:-f|-F|--field|--raw-field)\s+['"]?body=/.test(cmd)) return 'api';
  return null;
}

// For gh issue/pr, the body may live in a --body-file <path>; read it too.
function bodyFileText(cmd) {
  const m = cmd.match(/(?:--body-file|(?<![-\w])-F)(?:=|\s+)(["']?)([^\s"']+)\1/);
  if (!m) return '';
  const path = m[2];
  if (path === '-' || path.startsWith('<')) return ''; // stdin/heredoc already in the command string
  return fs.readFileSync(path, 'utf8').slice(0, 1_000_000);
}

function scan(text) {
  if (process.env.TRAILHEAD_SECRETGUARD_THROW === '1') throw new Error('forced fault (test seam)');
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  const a = text.match(ASSIGN_RE);
  if (a && !SAFE_VALUE.test(a[2])) return `hardcoded ${a[1].toLowerCase()}`;
  return null;
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', code: 'SECRET_IN_ISSUE_WRITE', reason }));
  process.exit(2);
}

// A scan we could NOT complete on a write we DID identify: surface it, don't hide it.
function adviseUnscanned(kind, err) {
  const detail = String((err && err.message) || err || 'unknown').slice(0, 120);
  process.stderr.write(`trailhead secret-guard: could not scan this ${kind} write (${detail}): NOT verified secret-free\n`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `⚠️ trailhead secret-guard could NOT complete its scan of this ${kind} write (${detail}). ` +
        'It did NOT verify the content is secret-free. Check the body by hand before it lands, or re-run. ' +
        'Do not treat this as a clean pass.',
    },
  }));
}

function run(data) {
  let cmd = '';
  try {
    cmd = (JSON.parse(data).tool_input || {}).command || '';
  } catch {
    process.exit(0); // unparseable input: nothing meaningful to say
  }
  const kind = ghIssueWrite(cmd);
  if (!kind) process.exit(0); // not a tracker write: out of scope

  // From here we KNOW it's a tracker write, so a scan failure must be OBSERVABLE.
  try {
    const text = cmd + '\n' + (kind !== 'api' ? bodyFileText(cmd) : '');
    const hit = scan(text);
    if (hit) {
      block(
        `trailhead: this ${kind === 'api' ? 'GitHub API write' : `gh ${kind}`} looks like it contains a secret (${hit}). ` +
        'Nothing sensitive may land on the tracker. Redact it: replace the value with `<REDACTED>` or an env-var reference ' +
        '(e.g. `$SUPABASE_KEY`), and post again. If this is a false positive (not a real secret), reword so it no longer matches a credential pattern.'
      );
    }
  } catch (e) {
    adviseUnscanned(kind, e); // fail open, but loudly: never a silent clean-looking pass
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends → give up (no write identified)
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { ghIssueWrite, bodyFileText, scan, SECRET_PATTERNS };
