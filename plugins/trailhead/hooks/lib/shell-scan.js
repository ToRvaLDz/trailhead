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

// What follows a `<<` introducer: an optional `-` (the terminator line may then
// be indented with leading tabs), then the tag, quoted or bare. Captures the
// `-` and the tag (single-quoted, double-quoted or bare) separately. Sticky, so
// it only matches right at the operator.
const HEREDOC_TAG_RE = /(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/y;

// A `#` starts a comment, and a `((` an arithmetic command, only at a word start.
const WORD_START_PREV_RE = /[\s;&|()]/;

// The ONE lexer behind heredoc detection and statement splitting. It scans a
// line with the shell context a bare regex lacks: a `<<` inside quotes, a
// comment, `$((..))`, `$[..]`, `((..))` or after a backslash is not an
// introducer, and `<<<` is a herestring. `st.stack` holds the open contexts as
// uniform { k, ... } frames: k is 'sq', 'dq', 'ansi' (`$'..'`), 'br' (`${..}`),
// 'sub' (`$(..)`, with a paren count n) or 'ar' (an arithmetic span); `st.cont` is set when the line
// ends in a backslash-newline continuation. It is mutated and carried to the next line, so a quote or arithmetic
// span that runs across lines keeps suppressing introducers. A `$(..)` is code
// again, even inside double quotes, so its heredocs count. Returns
// [{ dash, tag, quoted }]. When `seps` is given, the statement separators found
// in splittable code (top level or inside `$(..)`, never inside a quote,
// arithmetic span or comment) are pushed to it as { at, len, op }, so the
// splitters cut exactly where this lexer says code is. Best-effort: not a full
// shell parser (backticks, `$(( (a) ))` nesting tricks and `<<\TAG` are not
// modelled).
function scanLine(line, st, seps) {
  const found = [];
  const stack = st.stack;
  const cont0 = st.cont; // the previous line ended in a backslash: this one continues it
  let escAt = -2; // index of the last escaped char
  st.cont = false;
  // Is the char before index i a word boundary? An escaped char (`\ #x`) is not.
  // The `)` that closes an expansion (`$(..)`, `<(..)`, `$((..))`) ends no word
  // either: `$(x)# y` is not a comment, `(x)# y` is.
  let expCloseAt = -2;
  const isBoundary = (i) => WORD_START_PREV_RE.test(line[i - 1]) && escAt !== i - 1 && expCloseAt !== i - 1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const top = stack[stack.length - 1];
    if (top && top.k === 'sq') { if (c === "'") stack.pop(); continue; }
    if (top && top.k === 'ansi') { // $'..': a backslash escapes the next char, even a quote
      if (c === '\\') i++;
      else if (c === "'") stack.pop();
      continue;
    }
    if (top && top.k === 'ar') {
      if (top.mode === 'bracket') { if (c === ']') stack.pop(); continue; }
      if (c === '(') top.depth++;
      else if (c === ')' && --top.depth === 0) { stack.pop(); if (top.exp) expCloseAt = i; }
      continue;
    }
    if (c === '\\') { // escaped char stays literal
      if (i + 1 >= line.length) { // backslash-newline: the line continues
        st.cont = true;
        // The next line is glued to this text: it starts a word only if the
        // char before the backslash was a boundary (`a \<nl>#x` is a comment,
        // `a\<nl>#x` is not). A line of just `\` inherits the earlier answer.
        st.contBoundary = i === 0 ? (cont0 ? st.contBoundary : true) : isBoundary(i);
      }
      i++;
      escAt = i;
      continue;
    }
    if (c === '$' && line[i + 1] === '(' && line[i + 2] === '(' && parenIsArith(line, i + 3)) { stack.push({ k: 'ar', mode: 'paren', depth: 2, exp: true }); i += 2; continue; }
    if (c === '$' && line[i + 1] === '(') { stack.push({ k: 'sub', n: 0 }); i++; continue; }
    if (c === '$' && line[i + 1] === '{') { stack.push({ k: 'br' }); i++; continue; }
    if (top && top.k === 'dq') {
      if (c === '"') stack.pop();
      continue;
    }
    if (c === '$' && line[i + 1] === "'") { stack.push({ k: 'ansi' }); i++; continue; }
    if (c === "'") { stack.push({ k: 'sq' }); continue; }
    if (c === '"') { stack.push({ k: 'dq' }); continue; }
    if (c === '$' && line[i + 1] === '[') { stack.push({ k: 'ar', mode: 'bracket' }); i++; continue; }
    if (top && top.k === 'br') { if (c === '}') stack.pop(); continue; } // ${..}: no code until the matching }
    const wordStart = i === 0 ? (cont0 ? st.contBoundary : true) : isBoundary(i);
    if (c === '#' && wordStart) break; // comment to end of line
    if (c === '(' && line[i + 1] === '(' && wordStart && parenIsArith(line, i + 2)) { stack.push({ k: 'ar', mode: 'paren', depth: 2 }); i++; continue; }
    if (top && top.k === 'sub') {
      if (c === '(') { top.n++; continue; }
      if (c === ')') { if (top.n === 0) { stack.pop(); expCloseAt = i; } else top.n--; continue; }
    }
    // A process substitution `<(..)` / `>(..)` is code, like `$(..)`.
    if ((c === '<' || c === '>') && line[i + 1] === '(') { stack.push({ k: 'sub', n: 0 }); i++; continue; }
    if (seps && splittable(stack)) {
      const two = c + line[i + 1];
      if (two === '&&' || two === '||') { seps.push({ at: i, len: 2, op: two }); i++; continue; }
      if (c === ';' || c === '|') { seps.push({ at: i, len: 1, op: c }); continue; }
      // A lone `&` backgrounds, unless it is part of a redirection (`2>&1`, `>&2`, `&>f`).
      if (c === '&' && line[i - 1] !== '>' && line[i - 1] !== '<' && line[i + 1] !== '>') { seps.push({ at: i, len: 1, op: '&' }); continue; }
    }
    if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') { i += 2; continue; } // herestring
      HEREDOC_TAG_RE.lastIndex = i + 2;
      const m = HEREDOC_TAG_RE.exec(line);
      if (m) {
        found.push({ dash: m[1] === '-', tag: m[2] || m[3] || m[4], quoted: m[2] !== undefined || m[3] !== undefined });
        i = HEREDOC_TAG_RE.lastIndex - 1;
      } else {
        i++;
      }
    }
  }
  return found;
}

// `((` / `$((` open arithmetic only when the paren that closes the inner `(` is
// directly followed by `)`; `((a); b)` is nested subshells (and `$((a); b)` a
// substitution). `from` is the index just after the two opening parens. A span
// that runs past the end of the line is assumed to be arithmetic.
function parenIsArith(line, from) {
  let depth = 2;
  for (let j = from; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') { j++; continue; }
    if (c === "'" || c === '"') { // skip a quoted span on this line
      const end = line.indexOf(c, j + 1);
      if (end < 0) return true;
      j = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 1) return line[j + 1] === ')';
  }
  return true;
}

// Code that can be split into statements: the innermost open context is a
// `$(..)` substitution (or nothing). Frames are uniform { k, ... } objects, so
// no string can ever hit a String.prototype property by accident.
const splittable = (stack) => stack.length === 0 || stack[stack.length - 1].k === 'sub';

// The one walk shared by stripHeredocBodies, heredocBodies, countHeredocs and
// both splitters, so they always agree (secret-guard pairs heredocBodies with
// per-statement countHeredocs by position). A heredoc BODY is literal data
// (e.g. a script being written to a file), not shell statements run in the
// current shell. Whenever a line introduces heredocs, every following line up
// to and including each terminator is body. Returns { lines, keep, docs, seps,
// nl }: `keep[i]` is false for body and terminator lines; `docs` is
// [{ quoted, body }] in order of appearance (`quoted` is true for a quoted
// delimiter, whose body is literal text); `seps[i]` are the separators inside
// line i and `nl[i]` says whether the newline after it separates statements.
function scanHeredocs(cmd) {
  const lines = String(cmd).split('\n');
  const keep = new Array(lines.length).fill(true);
  const docs = [];
  const seps = lines.map(() => []);
  const nl = new Array(lines.length).fill(false);
  const st = { stack: [] };
  for (let i = 0; i < lines.length; i++) {
    const found = scanLine(lines[i], st, seps[i]);
    nl[i] = !st.cont && splittable(st.stack);
    // A line ending in a backslash continues on the next: that is ONE logical
    // line, and any heredoc body starts after its last physical line. So does a
    // quote opened after the introducer (`cat <<E 'a<nl>b'`): bash starts the
    // body after the logical line, which ends only when the quote closes.
    while ((st.cont || (found.length > 0 && !splittable(st.stack))) && i + 1 < lines.length) {
      i++;
      found.push(...scanLine(lines[i], st, seps[i]));
      nl[i] = !st.cont && splittable(st.stack);
    }
    // A single line can introduce more than one heredoc (`cmd <<A <<B`); the
    // bodies follow in order.
    for (const { dash, tag, quoted } of found) {
      const body = [];
      while (i + 1 < lines.length) {
        i++;
        keep[i] = false; // body or terminator: never a candidate statement
        const l = lines[i];
        if ((dash ? l.replace(/^\t+/, '') : l) === tag) break; // exact match, or (for `<<-`) tabs then the tag
        body.push(l);
      }
      docs.push({ quoted, body: body.join('\n') });
    }
  }
  return { lines, keep, docs, seps, nl };
}

// Remove every heredoc body (and terminator line) before the statement splitter
// sees the command. Handles multiple heredocs on one line and quoted tags.
function stripHeredocBodies(cmd) {
  const { lines, keep } = scanHeredocs(cmd);
  return lines.filter((_, i) => keep[i]).join('\n');
}

// The heredoc bodies of a command, in order of appearance: [{ quoted, body }].
function heredocBodies(cmd) {
  return scanHeredocs(cmd).docs;
}

// How many heredoc introducers a statement's text holds.
function countHeredocs(text) {
  const st = { stack: [] };
  return String(text).split('\n').reduce((n, line) => n + scanLine(line, st).length, 0);
}

// --- statement splitting -------------------------------------------------------

// Cut a command at the separators the lexer reports. Heredoc bodies are skipped
// (literal data, never statements). Returns [{ text, sep }] with the operator
// that ENDED each statement (null for the last), untrimmed and unfiltered.
function cutStatements(cmd, ops) {
  const { lines, keep, seps, nl } = scanHeredocs(cmd);
  const kept = lines.map((_, i) => i).filter((i) => keep[i]);
  const out = [];
  let cur = '';
  kept.forEach((i, k) => {
    let from = 0;
    for (const { at, len, op } of seps[i]) {
      if (!ops.includes(op)) continue;
      out.push({ text: cur + lines[i].slice(from, at), sep: op });
      cur = '';
      from = at + len;
    }
    cur += lines[i].slice(from);
    if (k === kept.length - 1) return;
    if (nl[i]) { out.push({ text: cur, sep: '\n' }); cur = ''; } else cur += '\n';
  });
  out.push({ text: cur, sep: null });
  return out;
}

// Split a shell string into top-level statements on `&&`, `||`, `;`, `|`, and
// newlines, respecting quotes, `$((..))`, `$[..]`, `((..))` and comments (so a
// separator INSIDE any of them, e.g. a grep pattern, does not fracture the
// statement). Heredoc bodies are stripped first so literal data written via
// `<<TAG` is never mistaken for statements. Splitting is purely
// character-driven (not whitespace-driven), so a glued separator with no
// surrounding spaces (`cat .env|grep KEY`, `cat .env;echo done`) still splits
// correctly. Best-effort: not a full shell parser, just enough to avoid the
// common false splits.
function splitStatements(cmd) {
  return cutStatements(cmd, [';', '|', '&&', '||']).map((x) => x.text.trim()).filter(Boolean);
}

// Like splitStatements, but each statement carries the operator that ENDED it
// (`;`, `\n`, `&&`, `||`, `|`, `&`, or null for the last one), and a lone `&`
// (background) also splits. Callers use the separators to tell which statements
// ran in the current shell and which in a subshell (pipeline or background).
// Same lexing and heredoc rules as splitStatements, which stays unchanged for
// its existing consumers. A `&` that is part of a redirection (`2>&1`, `>&2`,
// `&>f`) is not a separator.
function splitStatementsWithSeparators(cmd) {
  return cutStatements(cmd, [';', '|', '&&', '||', '&'])
    .map((x) => ({ text: x.text.trim(), sep: x.sep }))
    .filter((x) => x.text);
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
  heredocBodies,
  countHeredocs,
  splitStatements,
  splitStatementsWithSeparators,
  tokenize,
  skipEnvPrefix,
  GREP_VALUE_FLAGS,
  RG_VALUE_FLAGS,
  SEARCH_VERB_CONFIG,
  scanArgsSkippingPattern,
};
