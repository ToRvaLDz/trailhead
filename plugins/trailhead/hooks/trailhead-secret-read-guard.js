#!/usr/bin/env node
// trailhead-secret-read-guard.js: PreToolUse(Read|Bash) hook.
// Restores the `.env`/`.secrets` read protection that three `Read()` deny
// permission rules used to provide, before they were removed (#135). A
// `Read()` deny rule is a PERMISSION rule: under bypass permissions it still
// falls back to a manual approval prompt on Claude Code 2.1.259's new
// `cd-compound-read` check (the same headless-breaking prompt that
// trailhead-search-guard.js exists to route around, see #132-#134). This hook
// gets the same outcome — a secret file can never be read — as a HOOK `deny`
// decision instead, which does not arm that permission-layer prompt at all.
//
// Denies:
//   (a) a Read tool call whose `file_path` basename is a secret pattern; and
//   (b) a Bash command that touches a secret path as a plain positional file
//       operand, an option value (`--file=.env`, `-f .env`), or a `<` (or
//       glued `<file`) redirect target.
// A "secret pattern" is a basename that is exactly `.env`, exactly
// `.secrets`, or matches `.env.<anything>` (e.g. `.env.local`,
// `.env.production`). Matched on basename, so `app/.env` and `./.env.local`
// are caught the same as a bare `.env`.
//
// Deliberately best-effort on the Bash leg, like the sibling guards: a naive
// whitespace tokenizer, not a full shell parser. It does not care about `cd`
// shape at all (that is trailhead-search-guard.js's job) — it only asks
// "does any token here resolve to a secret path", so `cd app && grep x
// pubspec.yaml` is allowed (no secret token present) regardless of the `cd`.
//
// Denies with exit 2 + {"decision":"block","code":...,"reason":...} — same
// wire shape the sibling guards use for a block, which the PreToolUse hook
// contract treats as a deny. Allows everything else. Crash-safe: any error ->
// exit 0 (never wedge the user's workflow). Self-contained, no dependencies.
// Pure function exported for tests; runs as a hook when executed directly.

// --- path helpers ------------------------------------------------------------

function basename(p) {
  const s = String(p).split('/');
  return s[s.length - 1];
}

function stripQuotes(t) {
  const s = String(t);
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  return s;
}

// A basename is a "secret pattern" when it is exactly `.env`, exactly
// `.secrets`, or `.env.<something>` (e.g. `.env.local`, `.env.production`).
// Near-misses like `env.sample` (no leading dot) or `.environment` (no dot
// after `.env`) must NOT match.
function isSecretBasename(name) {
  if (!name) return false;
  if (name === '.env' || name === '.secrets') return true;
  return /^\.env\..+$/.test(name);
}

function isSecretPathArg(t) {
  const bare = stripQuotes(t);
  if (!bare) return false;
  return isSecretBasename(basename(bare));
}

// --- Bash leg: naive token scan ---------------------------------------------

// Flags that take a separate-token value which could itself be the secret
// path (`-f .env`, `--file .env`). Kept small and generic: this hook doesn't
// need to model every tool's flag surface, just the common file-value shapes.
const VALUE_FLAGS = new Set(['-f', '--file']);

// Walk the command's whitespace tokens (naive, matching the sibling guards'
// style) looking for a secret path used as a plain positional, an option
// value (`--file=.env` or `-f .env`), or a `<` redirect target (`< .secrets`
// or glued `<.secrets`). Returns the offending token (quotes stripped) or
// null. Best-effort: not a full shell parser.
function scanBashForSecretPath(cmd) {
  const tokens = String(cmd).split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // `<` redirect: glued (`<.secrets`) or separate-token (`< .secrets`).
    // Never confuse with a heredoc `<<TAG`.
    if (t.startsWith('<') && !t.startsWith('<<')) {
      const glued = t.slice(1);
      if (glued) {
        if (isSecretPathArg(glued)) return glued;
        continue;
      }
      const next = tokens[i + 1];
      if (next && isSecretPathArg(next)) return next;
      continue;
    }

    // `--flag=value` form.
    if (t.startsWith('-')) {
      const eq = t.indexOf('=');
      if (eq > 0) {
        const val = t.slice(eq + 1);
        if (isSecretPathArg(val)) return val;
        continue;
      }
      // `-f value` / `--file value` (separate-token value): check the next
      // token as the value and skip re-testing this flag token itself.
      if (VALUE_FLAGS.has(t)) {
        const next = tokens[i + 1];
        if (next && isSecretPathArg(next)) return next;
        continue;
      }
      continue; // some other flag: not itself a file operand
    }

    // Plain positional (file operand or search pattern that happens to be a
    // secret path token - either way, the tracker never sees the content).
    if (isSecretPathArg(t)) return t;
  }
  return null;
}

// --- top-level detection -----------------------------------------------------

// Detect a secret-file read across a Read or Bash tool call. Returns
// { path } on a hit, or null. Pure, exported for tests.
function detectSecretRead(toolName, toolInput) {
  const input = toolInput || {};
  if (toolName === 'Read') {
    const p = input.file_path;
    if (p && isSecretPathArg(String(p))) return { path: String(p) };
    return null;
  }
  if (toolName === 'Bash') {
    const cmd = input.command || '';
    const hit = scanBashForSecretPath(cmd);
    return hit ? { path: hit } : null;
  }
  return null;
}

function block(hit) {
  const reason =
    `trailhead secret-read guard: blocked a read of secret file \`${hit.path}\` ` +
    '(.env / .env.* / .secrets). This replaces the Read() deny permission rules ' +
    "removed in #135 with a hook-level deny, so secrets stay unreadable without " +
    "arming Claude Code 2.1.259's cd-compound-read approval prompt. If this file " +
    'genuinely needs inspecting, do so outside the agent session.';
  process.stdout.write(JSON.stringify({ decision: 'block', code: 'SECRET_READ_BLOCKED', reason }));
  process.exit(2);
}

function run(data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    process.exit(0); // unparseable input: nothing to gate
  }
  try {
    const hit = detectSecretRead(parsed.tool_name, parsed.tool_input);
    if (hit) block(hit);
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

module.exports = { detectSecretRead };
