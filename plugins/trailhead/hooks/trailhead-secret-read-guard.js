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
//       operand, an option value (`--file=.env`, `-f .env`, glued `-f.env`),
//       or a `<` (or glued `<file`) redirect target.
// A "secret pattern" is a basename that is exactly `.env`, exactly
// `.secrets`, or matches `.env.<anything>` (e.g. `.env.local`,
// `.env.production`), matched CASE-INSENSITIVELY (`.ENV`/`.SECRETS` are the
// same file on macOS/Windows). Matched on basename, so `app/.env` and
// `./.env.local` are caught the same as a bare `.env`.
//
// #135 follow-up (adversarial review found real false negatives/positives in
// the original naive `.split(/\s+/)` Bash tokenizer):
//   - Finding 1 (glued shell metacharacters, e.g. `cat .env|grep KEY`,
//     `cat .env;echo done`, `cat .env&&echo done`) is fixed by scanning
//     QUOTE-AWARE, STATEMENT-BASED top-level statements (splitStatements),
//     which split on operator characters regardless of surrounding
//     whitespace. `bash -c "cat .env"` / `eval "cat .env"` are fixed by
//     recursing into the quoted sub-command's text as a nested command.
//   - Finding 2 (glued short-option value, `cat -f.env`) is fixed by also
//     testing a value-flag's glued suffix (`token.slice(2)`).
//   - Finding 3 (bare `.env` inside quoted prose, e.g. `git commit -m
//     "document .env usage"`) is fixed by a quote-aware tokenizer that keeps
//     a multi-word quoted phrase as ONE opaque token, never splitting it into
//     separate words.
//   - Finding 4 (a quoted grep PATTERN that happens to look like a secret
//     path, e.g. `grep ".env" config.txt`) is fixed by routing search verbs
//     (grep/rg/ag/sed/awk) through the shared pattern-positional-skipping
//     walk, so the pattern is never mistaken for the file operand.
//   - Finding 5 (case sensitivity) is fixed by lowercasing the basename
//     before the pattern test.
// The quote-aware tokenizer/statement-splitter and the search-verb handling
// are shared with trailhead-search-guard.js via lib/shell-scan.js, so the two
// guards can never drift into two divergent tokenizers again.
//
// Deliberately best-effort on the Bash leg, like the sibling guards: not a
// full shell parser. It does not care about `cd` shape at all (that is
// trailhead-search-guard.js's job) — it only asks "does any token here
// resolve to a secret path", so `cd app && grep x pubspec.yaml` is allowed
// (no secret token present) regardless of the `cd`.
//
// Denies with exit 2 + {"decision":"block","code":...,"reason":...} — same
// wire shape the sibling guards use for a block, which the PreToolUse hook
// contract treats as a deny. Allows everything else. Crash-safe: any error ->
// exit 0 (never wedge the user's workflow). Self-contained (its own
// dependency is the sibling lib/ module, no external packages). Pure
// function exported for tests; runs as a hook when executed directly.

const {
  basename,
  stripQuotes,
  splitStatements,
  tokenize,
  SEARCH_VERB_CONFIG,
  scanArgsSkippingPattern,
} = require('./lib/shell-scan.js');

// --- path helpers ------------------------------------------------------------

// A basename is a "secret pattern" when it is exactly `.env`, exactly
// `.secrets`, or `.env.<something>` (e.g. `.env.local`, `.env.production`),
// matched case-insensitively (`.ENV`/`.Secrets` are the same file on a
// case-insensitive filesystem). Near-misses like `env.sample` (no leading
// dot) or `.environment` (no dot after `.env`) must NOT match.
function isSecretBasename(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  if (lower === '.env' || lower === '.secrets') return true;
  return /^\.env\..+$/.test(lower);
}

function isSecretPathArg(t) {
  const bare = stripQuotes(t);
  if (!bare) return false;
  return isSecretBasename(basename(bare));
}

// --- Bash leg: quote-aware, statement-based scan -----------------------------

// Flags that take a separate-token value which could itself be the secret
// path (`-f .env`, `--file .env`), or (finding #2) a GLUED value on a short
// flag (`-f.env`). Kept small and generic: this hook doesn't need to model
// every tool's flag surface, just the common file-value shapes.
const VALUE_FLAGS = new Set(['-f', '--file']);

// The pattern-first search verbs (grep/rg/ag/sed/awk), shared with
// trailhead-search-guard.js. Their first positional is a PATTERN, not a file
// operand, so it must be skipped before scanning for a secret FILE argument
// (finding #4: `grep ".env" config.txt` reads config.txt, not `.env`).
const SEARCH_VERBS = new Set(Object.keys(SEARCH_VERB_CONFIG));

// `bash -c "<cmd>"` / `sh -c "<cmd>"` / `zsh -c "<cmd>"` / `eval "<cmd>"`: the
// secret read hides inside that quoted string, invisible to a plain
// positional/flag scan (finding #1), so these are recursed into as a nested
// command.
const SHELL_DASH_C_VERBS = new Set(['bash', 'sh', 'zsh', 'ksh']);

// A token can still end with a glued shell metacharacter that splitStatements
// doesn't split on (grouping punctuation left over from a subshell/brace
// group, or a stray backtick closing a command substitution). Strip a run of
// these from the token's tail before basename-testing it, so e.g. the last
// token of `(cat .env)` (`.env)`) still resolves to `.env`.
const TRAILING_PUNCT_RE = /[|;&`)}]+$/;
function stripTrailingPunct(t) {
  return String(t).replace(TRAILING_PUNCT_RE, '');
}

// Scan one already-tokenized statement's argument tokens (verb NOT stripped)
// for a secret path used as a plain positional, an option value
// (`--file=.env`, `-f .env`, glued `-f.env`), or a `<` (or glued `<file`)
// redirect target. Returns the offending token or null.
function scanTokensForSecretPath(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = stripTrailingPunct(tokens[i]);
    if (!t) continue;

    // `<` redirect: glued (`<.secrets`) or separate-token (`< .secrets`).
    // Never confuse with a heredoc `<<TAG` (already stripped out by
    // splitStatements upstream, but be defensive).
    if (t.startsWith('<') && !t.startsWith('<<')) {
      const glued = t.slice(1);
      if (glued) {
        if (isSecretPathArg(glued)) return glued;
        continue;
      }
      const next = i + 1 < tokens.length ? stripTrailingPunct(tokens[i + 1]) : null;
      if (next && isSecretPathArg(next)) return next;
      continue;
    }

    if (t.startsWith('-') && t !== '-') {
      // `--flag=value` form.
      const eq = t.indexOf('=');
      if (eq > 0) {
        const val = t.slice(eq + 1);
        if (isSecretPathArg(val)) return val;
        continue;
      }
      // `-f value` / `--file value` (separate-token value).
      if (VALUE_FLAGS.has(t)) {
        const next = i + 1 < tokens.length ? stripTrailingPunct(tokens[i + 1]) : null;
        if (next && isSecretPathArg(next)) return next;
        continue;
      }
      // Glued short-option value (`-f.env`, finding #2): a single-dash flag
      // whose flag letter is a known value flag, with the value glued
      // directly onto it.
      if (!t.startsWith('--') && t.length > 2) {
        const shortFlag = t.slice(0, 2);
        if (VALUE_FLAGS.has(shortFlag)) {
          const glued = t.slice(2);
          if (isSecretPathArg(glued)) return glued;
        }
      }
      continue; // some other flag: not itself a file operand
    }

    // Plain positional (file operand or search pattern token).
    if (isSecretPathArg(t)) return t;
  }
  return null;
}

// Does `stmtTokens` invoke `bash -c "<cmd>"` / `sh -c "<cmd>"` / `eval
// "<cmd>"` (etc.)? If so, return the inner command TEXT (quotes stripped, not
// yet re-tokenized) so the caller can recurse into it as a nested command.
// Best-effort: only the common single-quoted-argument idiom, not every way a
// shell can be told to execute a string.
function extractNestedCommand(stmtTokens) {
  if (!stmtTokens.length) return null;
  const bin = basename(stmtTokens[0]);
  if (bin === 'eval') {
    const rest = stmtTokens.slice(1);
    if (!rest.length) return null;
    return stripQuotes(rest.join(' '));
  }
  if (SHELL_DASH_C_VERBS.has(bin)) {
    const cIdx = stmtTokens.indexOf('-c');
    if (cIdx === -1 || cIdx + 1 >= stmtTokens.length) return null;
    return stripQuotes(stmtTokens.slice(cIdx + 1).join(' '));
  }
  return null;
}

// Scan a single top-level statement for a secret path. Recurses into a
// bash -c/eval quoted sub-command first (finding #1), routes grep/rg/ag/sed/
// awk through the shared pattern-skipping walk (finding #4), and falls back
// to the plain per-token walk for everything else (cat, head, redirects,
// etc.).
function scanStatementForSecretPath(stmt) {
  const tokens = tokenize(stmt);
  if (!tokens.length) return null;

  const nested = extractNestedCommand(tokens);
  if (nested) {
    const hit = scanBashForSecretPath(nested);
    if (hit) return hit;
    // fall through: also scan the wrapper statement's own tokens (e.g. a
    // stray `-f .env` on the wrapper itself) for defence in depth.
  }

  const bin = basename(tokens[0]);
  if (SEARCH_VERBS.has(bin)) {
    return scanArgsSkippingPattern(tokens.slice(1), SEARCH_VERB_CONFIG[bin], isSecretPathArg);
  }
  return scanTokensForSecretPath(tokens);
}

// Walk the command's top-level statements (quote-aware; `|`, `;`, `&&`,
// `||`, and newlines all split, even with no surrounding whitespace, e.g.
// `cat .env|grep KEY`) looking for a secret path used as a plain positional,
// an option value, or a `<` redirect target. Returns the offending token
// (quotes/punctuation not necessarily stripped) or null. Best-effort: not a
// full shell parser.
function scanBashForSecretPath(cmd) {
  const statements = splitStatements(cmd);
  for (const stmt of statements) {
    const hit = scanStatementForSecretPath(stmt);
    if (hit) return hit;
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
