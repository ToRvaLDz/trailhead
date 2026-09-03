'use strict';
// shell-scan.js: shared quote-aware shell scanning helpers, extracted from
// trailhead-search-guard.js (#135 follow-up) so trailhead's Bash-command
// guards share ONE tokenizer/statement-splitter instead of drifting copies.
// trailhead-secret-read-guard.js's original Bash leg used a naive
// `.split(/\s+/)` tokenizer over the WHOLE command string, which let glued
// shell metacharacters (`cat .env|grep KEY`, `cat .env;echo done`) slip past
// detection entirely (a false negative in a security guard) and let a bare
// `.env` inside multi-word quoted prose (`"document .env usage"`) trip a
// false positive. This module's `splitStatements` + `tokenize` fix both: the
// former is quote-aware and splits on operator characters regardless of
// surrounding whitespace, the latter keeps a multi-word quoted phrase as ONE
// opaque token instead of splitting it into separate words.
//
// Consumers: trailhead-search-guard.js and trailhead-secret-read-guard.js.
// Self-contained, no external dependencies. Best-effort, like the guards that
// use it: not a full shell parser, just enough to close their known gaps.

// --- path helpers ------------------------------------------------------------

function basename(p) {
  const s = String(p).split('/');
  return s[s.length - 1];
}

// --- quoting -----------------------------------------------------------------

// Strip a single pair of enclosing quotes: the WHOLE token must start AND end
// with the same quote character. A multi-word quoted phrase kept as one token
// by tokenize() (below) round-trips through this to its bare content
// (spaces and all) - callers testing that bare content against a basename
// pattern then correctly see prose, not a path, unless the phrase IS exactly
// a path (e.g. `".env"` -> `.env`, still flagged by design).
function stripQuotes(t) {
  const s = String(t);
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  return s;
}

// --- heredoc bodies ------------------------------------------------------------

// Matches a heredoc introducer anywhere it can appear on a line: `<<TAG`,
// `<<'TAG'`, `<<"TAG"`, and `<<-TAG` (which also allows the terminator line to
// be indented with leading tabs). Captures the operator's `-` and the tag
// (quoted or bare) separately.
const HEREDOC_RE = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/;

// A heredoc BODY is literal data (e.g. a script being written to a file), not
// shell statements executed in the current shell. Scan the command line by
// line; whenever a line introduces a heredoc, skip every following line up to
// and including the matching terminator line before it ever reaches the
// statement splitter below. Handles multiple heredocs on the same command and
// both quoted and unquoted tags. Best-effort: not a full shell parser.
function stripHeredocBodies(cmd) {
  const lines = String(cmd).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    out.push(line);
    let m;
    // A single line can introduce more than one heredoc (`cmd <<A <<B`); walk
    // left to right and skip each body in turn.
    while ((m = HEREDOC_RE.exec(line))) {
      const dashStrip = m[1] === '-';
      const tag = m[2] || m[3] || m[4];
      line = line.slice(m.index + m[0].length); // keep scanning the rest of this line for more `<<TAG`s
      if (!tag) break;
      // Skip lines until the terminator: an exact match, or (for `<<-`) the
      // tag preceded only by tabs.
      while (i + 1 < lines.length) {
        i++;
        const body = lines[i];
        const term = dashStrip ? body.replace(/^\t+/, '') : body;
        if (term === tag) break; // terminator line: consumed, not a candidate statement either
        // else: heredoc data line, deliberately NOT pushed to `out` - it must
        // never become a candidate statement.
      }
    }
  }
  return out.join('\n');
}

// --- statement splitting -------------------------------------------------------

// Split a shell string into top-level statements on `&&`, `||`, `;`, `|`, and
// newlines, respecting single/double quotes (so a separator INSIDE a quoted
// argument, e.g. a grep pattern, does not fracture the statement). Heredoc
// bodies are stripped first (see stripHeredocBodies) so literal data written
// via `<<TAG` is never mistaken for statements. Splitting is purely
// character-driven (not whitespace-driven), so a glued separator with no
// surrounding spaces (`cat .env|grep KEY`, `cat .env;echo done`) still splits
// correctly. Best-effort: not a full shell parser, just enough to avoid the
// common false splits.
function splitStatements(cmd) {
  const s = stripHeredocBodies(String(cmd));
  const stmts = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; } // escaped char stays literal
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === '&' && s[i + 1] === '&') { stmts.push(cur); cur = ''; i++; continue; }
    if (c === '|' && s[i + 1] === '|') { stmts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { stmts.push(cur); cur = ''; continue; }
    cur += c;
  }
  stmts.push(cur);
  return stmts.map((t) => t.trim()).filter(Boolean);
}

// --- tokenizing ----------------------------------------------------------------

// Quote-aware whitespace tokenizer: splits a statement on UNQUOTED
// whitespace, keeping a `"..."`/`'...'` span - even a MULTI-WORD one - as a
// single opaque token (quotes are kept in the token; stripQuotes() unwraps
// them). This is what keeps quoted prose like `"document .env usage"` safe:
// the whole phrase is one token, so a bare `.env` glued mid-phrase is never a
// separate candidate token, while a lone quoted path like `".env"` still
// round-trips to the bare `.env` via stripQuotes for basename testing.
// Mirrors splitStatements' escape handling (`\"` inside a double-quoted span
// stays literal, never closes the quote early). Best-effort: not a full shell
// parser (a real shell also strips quotes/joins adjacent quoted+bare runs
// into one word; this keeps the surrounding quotes intact instead, which is
// enough for the callers' basename tests).
function tokenize(stmt) {
  const s = String(stmt).trim();
  const tokens = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function skipEnvPrefix(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return i;
}

// --- search-verb argument scanning ----------------------------------------

// grep/rg/ag/sed/awk take a PATTERN (or script/program) as their first
// positional. Shared between the search guard (which skips the pattern before
// flagging a relative FILE arg) and the secret-read guard (which skips the
// pattern before flagging a SECRET FILE arg), so e.g. `grep ".env" config.txt`
// is never mistaken for a `.env` read: the FILE operand is config.txt, the
// PATTERN just happens to look like a secret path.
const GREP_VALUE_FLAGS = new Set([
  '-e', '-f', '-A', '-B', '-C', '-m', '-D',
  '--include', '--exclude', '--exclude-dir', '--exclude-from',
  '--after-context', '--before-context', '--context', '--max-count',
]);

// ripgrep has several value-taking flags GNU grep doesn't (glob/type filters,
// column limits); without these, scanning treats their value as a plain
// positional and misattributes it as the pattern/file in the block reason.
const RG_VALUE_FLAGS = new Set([
  ...GREP_VALUE_FLAGS,
  '-g', '--glob', '-t', '--type', '-T', '--type-not', '-M', '--max-columns',
]);

const SEARCH_VERB_CONFIG = {
  grep: { patternFirst: true, valueFlags: GREP_VALUE_FLAGS, patternFlags: new Set(['-e']) },
  rg: { patternFirst: true, valueFlags: RG_VALUE_FLAGS, patternFlags: new Set(['-e']) },
  ag: { patternFirst: true, valueFlags: GREP_VALUE_FLAGS, patternFlags: new Set(['-e']) },
  sed: { patternFirst: true, valueFlags: new Set(['-e', '-f']), patternFlags: new Set(['-e']) },
  awk: { patternFirst: true, valueFlags: new Set(['-f', '-v']), patternFlags: new Set() },
};

// Walk a verb's argument tokens (verb itself already stripped), skipping
// flags (and their separate-token values), an explicit `--` end-of-options
// marker (which must not itself swallow the next real positional), and the
// leading pattern/script positional when the verb has one (`config.patternFirst`).
// Returns the first token for which `isMatch(token)` is true, or null.
// Generic over the predicate so both guards can drive it with their own
// notion of "interesting" (a relative file arg vs. a secret path arg).
function scanArgsSkippingPattern(args, config, isMatch) {
  let patternConsumed = !config.patternFirst;
  let afterDashDash = false; // once seen, every remaining token is positional, never a flag
  for (let j = 0; j < args.length; j++) {
    const t = args[j];
    if (!afterDashDash && t === '--') { afterDashDash = true; continue; }
    if (!afterDashDash && t.startsWith('-') && t !== '-') {
      if (config.valueFlags.has(t)) {
        j++; // consume its separate-token value
        if (config.patternFlags && config.patternFlags.has(t)) patternConsumed = true;
      }
      continue;
    }
    if (!patternConsumed) { patternConsumed = true; continue; } // leading pattern/script positional
    if (isMatch(t)) return t;
  }
  return null;
}

module.exports = {
  basename,
  stripQuotes,
  stripHeredocBodies,
  splitStatements,
  tokenize,
  skipEnvPrefix,
  GREP_VALUE_FLAGS,
  RG_VALUE_FLAGS,
  SEARCH_VERB_CONFIG,
  scanArgsSkippingPattern,
};
