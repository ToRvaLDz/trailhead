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
// [{ at, depth, dash, tag, quoted }] (`at` is the index of the `<<`, `depth` the
// number of open contexts there). When `seps` is given, the statement separators found
// in splittable code (top level or inside `$(..)`, never inside a quote,
// arithmetic span or comment) are pushed to it as { at, len, op }, so the
// splitters cut exactly where this lexer says code is. Best-effort: not a full
// shell parser (`$(( (a) ))` nesting tricks and `<<\TAG` are not modelled,
// nor is a backtick nested inside a backtick span other than as an escaped
// char; nor is the body order of a heredoc nested in another heredoc's pending `"$(..)"`, e.g. `cat <<E "$(cat <<A ..)"`).
// When `subs` is given ({ open(at, bq), close(at) }), it is told where each
// OUTERMOST `$(..)` / `<(..)` / `>(..)` / backtick body starts (the index after
// the opener; `bq` is true for a backtick) and where it ends (the index of the
// closing `)` or backtick), so substitutionBodies reads the bodies off this
// lexer instead of running a second one.
// A backtick span is NOT a stack frame: it lives in `st.bq` ({ outer } or unset)
// and is opened by an unescaped backtick in code, `dq`, `br` or `sub` context
// (never in `sq`, `ansi`, arithmetic or a comment) and closed by the next
// unescaped one. The span is OPAQUE: while it is open only a backslash (skips
// the next char) and the closing backtick are looked at, as in the shell, which
// finds the closing backtick first and parses the body separately (so a quote
// inside it cannot desync this lexer). Its separators and heredocs therefore
// do not count; the guards recurse into the body via substitutionBodies. It is
// kept off the stack so heredoc depth is untouched. `st.bq.dq` records whether
// it sits in double quotes (nearest `dq`/`sub` frame is `dq`), where the shell
// also unescapes `\"` in the body. A span that never closes runs to the end of
// the input.
function scanLine(line, st, seps, subs) {
  const found = [];
  const stack = st.stack;
  const parens = {}; // parenIsArith's per-line match cache
  const cont0 = st.cont; // the previous line ended in a backslash: this one continues it
  let escAt = -2; // index of the last escaped char
  // Index of the last bare `$` (not escaped, not the 2nd of `$$`). A bare `$` that
  // ended the previous line before its `\<nl>` is still adjacent: it counts as index -1.
  let bareAt = cont0 && st.bareEnd ? -1 : -2;
  st.cont = false;
  st.bareEnd = false;
  // Is the char before index i a word boundary? An escaped char (`\ #x`) is not.
  // The `)` that closes an expansion (`$(..)`, `<(..)`, `$((..))`) ends no word
  // either: `$(x)# y` is not a comment, `(x)# y` is.
  let expCloseAt = -2;
  // Push a `$(..)` / `<(..)` frame; the outermost one is reported to `subs`.
  const openSub = (bodyAt) => {
    const outer = !stack.some((f) => f.k === 'sub');
    stack.push({ k: 'sub', n: 0, outer });
    if (subs && outer) subs.open(bodyAt);
  };
  const isBoundary = (i) => WORD_START_PREV_RE.test(line[i - 1]) && escAt !== i - 1 && expCloseAt !== i - 1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (st.bq) { // opaque backtick span: only a backslash and the closing backtick matter
      if (c === '\\') i++;
      else if (c === '`') { if (subs && st.bq.outer) subs.close(i); st.bq = null; }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && top.k === 'sq') { if (c === "'") stack.pop(); continue; }
    if (top && top.k === 'ansi') { // $'..': a backslash escapes the next char, even a quote
      if (c === '\\') i++;
      else if (c === "'") stack.pop();
      continue;
    }
    if (top && top.k === 'ar') {
      // A `$(..)` inside arithmetic runs: push a sub frame (its own parens
      // balance there), unless it is itself an arithmetic `$((..))`.
      if (c === '$' && line[i + 1] === '(' && !(line[i + 2] === '(' && parenIsArith(line, i + 3, parens))) { openSub(i + 2); i++; continue; }
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
        st.bareEnd = i === 0 ? bareAt === -1 : bareAt === i - 1; // carry the bare-dollar bit over
      }
      i++;
      escAt = i;
      continue;
    }
    if (c === '`') { // a backtick substitution opens here (its close is handled above)
      const outer = !stack.some((f) => f.k === 'sub');
      const near = stack.slice().reverse().find((f) => f.k === 'dq' || f.k === 'sub');
      const dq = !!near && near.k === 'dq';
      st.bq = { outer, dq };
      if (subs && outer) subs.open(i + 1, true, dq);
      continue;
    }
    if (c === '$' && line[i + 1] === '(' && line[i + 2] === '(' && parenIsArith(line, i + 3, parens)) { stack.push({ k: 'ar', mode: 'paren', depth: 2, exp: true }); i += 2; continue; }
    if (c === '$' && line[i + 1] === '(') { openSub(i + 2); i++; continue; }
    if (c === '$' && line[i + 1] === '{') { stack.push({ k: 'br' }); i++; continue; }
    if (top && top.k === 'dq') {
      if (c === '"') stack.pop();
      continue;
    }
    if (c === '$') {
      // Only a bare `$` opens `$'..'`: not an escaped one (skipped above) and not the 2nd of `$$` (the PID).
      const bare = bareAt !== i - 1;
      if (bare) bareAt = i;
      if (bare && line[i + 1] === "'") { stack.push({ k: 'ansi' }); i++; continue; }
    }
    // A `'` glued to a bare `$` that ended the previous line (`$\<nl>'..'`) is ANSI-C too.
    if (c === "'" && i === 0 && bareAt === -1) { stack.push({ k: 'ansi' }); continue; }
    if (c === "'") { stack.push({ k: 'sq' }); continue; }
    if (c === '"') { stack.push({ k: 'dq' }); continue; }
    if (c === '$' && line[i + 1] === '[') { stack.push({ k: 'ar', mode: 'bracket' }); i++; continue; }
    if (top && top.k === 'br') { if (c === '}') stack.pop(); continue; } // ${..}: no code until the matching }
    const wordStart = i === 0 ? (cont0 ? st.contBoundary : true) : isBoundary(i);
    if (c === '#' && wordStart) break; // comment to end of line
    if (c === '(' && line[i + 1] === '(' && wordStart && parenIsArith(line, i + 2, parens)) { stack.push({ k: 'ar', mode: 'paren', depth: 2 }); i++; continue; }
    if (top && top.k === 'sub') {
      if (c === '(') { top.n++; continue; }
      if (c === ')') { if (top.n === 0) { stack.pop(); expCloseAt = i; if (subs && top.outer) subs.close(i); } else top.n--; continue; }
    }
    // A process substitution `<(..)` / `>(..)` is code, like `$(..)`.
    if ((c === '<' || c === '>') && line[i + 1] === '(') { openSub(i + 2); i++; continue; }
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
        found.push({ at: i, depth: stack.length, dash: m[1] === '-', tag: m[2] || m[3] || m[4], quoted: m[2] !== undefined || m[3] !== undefined });
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
// that runs past the end of the line is assumed to be arithmetic. `cache` is one
// object per line: a single left-to-right pass (skipping quoted spans and
// escapes) matches every `(` it visits to its `)`, so the many calls on a line
// full of `((` stay linear instead of each rescanning the rest of the line.
function parenIsArith(line, from, cache) {
  const open = from - 1; // the inner `(`
  if (!cache.close || !cache.close.has(open)) cache.close = matchParens(line, from);
  const close = cache.close.get(open);
  return close < 0 ? true : line[close + 1] === ')';
}

// Match every `(` visited from `from` on to its `)`: Map(open -> close, or -1
// when it never closes or an unclosed quote hides the rest of the line). The
// paren just before `from` is the inner one of a `((`, so it is seeded as open.
function matchParens(line, from) {
  const close = new Map([[from - 1, -1]]);
  const opens = [from - 1];
  for (let j = from; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') { j++; continue; }
    if (c === "'" || c === '"') { // skip a quoted span on this line
      const end = line.indexOf(c, j + 1);
      if (end < 0) break;
      j = end;
    } else if (c === '(') { close.set(j, -1); opens.push(j); }
    else if (c === ')' && opens.length > 0) close.set(opens.pop(), j);
  }
  return close;
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
// [{ quoted, body }] in order of appearance (`hd[i]` holds the introducer positions on line i) (`quoted` is true for a quoted
// delimiter, whose body is literal text); `seps[i]` are the separators inside
// line i and `nl[i]` says whether the newline after it separates statements.
function scanHeredocs(cmd) {
  const lines = String(cmd).split('\n');
  const keep = new Array(lines.length).fill(true);
  const docs = [];
  const seps = lines.map(() => []);
  const nl = new Array(lines.length).fill(false);
  const hd = lines.map(() => []); // hd[i]: indexes of the heredoc introducers on line i
  const st = { stack: [] };
  for (let i = 0; i < lines.length; i++) {
    const found = scanLine(lines[i], st, seps[i]);
    hd[i] = found.map((f) => f.at);
    nl[i] = !st.cont && !st.bq && splittable(st.stack);
    // A line ending in a backslash continues on the next: that is ONE logical
    // line, and any heredoc body starts after its last physical line. So does a
    // quote opened after the introducer (`cat <<E 'a<nl>b'`): bash starts the
    // body after the logical line, which ends only when the quote closes.
    // A heredoc introduced inside the innermost open `$(..)` (the `"$(cat <<EOF`
    // idiom) starts its body on the next physical line; one introduced at an
    // outer depth waits until every context opened after it has closed.
    while ((st.cont || (st.bq && found.length > 0) || found.some((f) => st.stack.length > f.depth)) && i + 1 < lines.length) {
      i++;
      const more = scanLine(lines[i], st, seps[i]);
      hd[i] = more.map((f) => f.at);
      found.push(...more);
      nl[i] = !st.cont && !st.bq && splittable(st.stack);
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
  return { lines, keep, docs, seps, nl, hd };
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

function lexCount(text) {
  const st = { stack: [] };
  return String(text).split('\n').reduce((n, line) => n + scanLine(line, st).length, 0);
}

// How many heredoc introducers a statement holds. A splitter entry carries the
// count from the single whole-command scan (`heredocs`), which is what callers
// pairing statements with heredocBodies must use. A plain string is lexed
// standalone from an empty stack: pure, no memory of any earlier split, so a
// fragment cut out of a larger command may count differently from its entry.
function countHeredocs(stmt) {
  if (stmt && typeof stmt === 'object' && typeof stmt.heredocs === 'number') return stmt.heredocs;
  return lexCount(stmt && typeof stmt === 'object' ? stmt.text : stmt);
}

// The text of every outermost command substitution in a command: `$(..)`,
// `<(..)`, `>(..)` and backticks, including those inside double quotes (the
// shell runs them), never one in single quotes, `$'..'`, arithmetic, a comment or a
// heredoc body. Nested ones are not returned: callers recurse into a body to
// reach them. A backtick body is returned as the shell would run it: `\``,
// `\\` and `\$` (and `\"` inside double quotes) are unescaped, so a nested `\`..\`` becomes a real backtick
// span in the body. A body can span lines (joined with '\n'); one that never closes
// runs to the end of the input (fail toward scanning). Read off scanLine's
// `sub` frames, so it agrees with the splitters on what is code.
function substitutionBodies(cmd) {
  // Cut from the ORIGINAL text: a heredoc inside a body keeps its body and
  // terminator lines there (the caller's own scan strips them), while lines
  // that are heredoc body are never lexed, so a `$(..)` in one is not returned.
  const { lines, keep } = scanHeredocs(cmd);
  const st = { stack: [] };
  const out = [];
  let cur = null; // text of the open body so far, or null
  let from = 0; // where the open body's text starts on the current line
  let bq = null; // the open body is a backtick span: null, or { dq } (in double quotes)
  const unescape = (t) => (bq ? t.replace(bq.dq ? /\\([`\\$"])/g : /\\([`\\$])/g, '$1') : t);
  const subs = {
    open: (at, isBq, dq) => { cur = ''; from = at; bq = isBq ? { dq: !!dq } : null; },
    close: (at) => { out.push(unescape(cur + lines[li].slice(from, at))); cur = null; },
  };
  let li = 0;
  for (; li < lines.length; li++) {
    if (!keep[li]) { if (cur !== null) cur += lines[li] + '\n'; continue; }
    from = 0;
    scanLine(lines[li], st, undefined, subs);
    if (cur !== null) cur += lines[li].slice(from) + '\n';
  }
  if (cur !== null) out.push(unescape(cur.slice(0, -1))); // unterminated: the remainder
  return out;
}

// --- statement splitting -------------------------------------------------------

// Cut a command at the separators the lexer reports. Heredoc bodies are skipped
// (literal data, never statements). Returns [{ text, sep }] with the operator
// that ENDED each statement (null for the last) and the number of heredoc
// introducers it holds (counted from the scan positions), untrimmed and unfiltered.
function cutStatements(cmd, ops) {
  const { lines, keep, seps, nl, hd } = scanHeredocs(cmd);
  const kept = lines.map((_, i) => i).filter((i) => keep[i]);
  const out = [];
  let cur = '';
  let heredocs = 0;
  kept.forEach((i, k) => {
    let from = 0;
    const cuts = seps[i].filter((s) => ops.includes(s.op));
    let h = 0;
    for (const { at, len, op } of cuts) {
      while (h < hd[i].length && hd[i][h] < at) { heredocs++; h++; }
      out.push({ text: cur + lines[i].slice(from, at), sep: op, heredocs });
      cur = '';
      heredocs = 0;
      from = at + len;
    }
    heredocs += hd[i].length - h;
    cur += lines[i].slice(from);
    if (k === kept.length - 1) return;
    if (nl[i]) { out.push({ text: cur, sep: '\n', heredocs }); cur = ''; heredocs = 0; } else cur += '\n';
  });
  out.push({ text: cur, sep: null, heredocs });
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
  return cutStatements(cmd, [';', '|', '&&', '||'])
    .map((x) => ({ text: x.text.trim(), heredocs: x.heredocs }))
    .filter((x) => x.text)
    .map((x) => x.text);
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
    .map((x) => ({ text: x.text.trim(), sep: x.sep, heredocs: x.heredocs }))
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
  substitutionBodies,
  tokenize,
  skipEnvPrefix,
  GREP_VALUE_FLAGS,
  RG_VALUE_FLAGS,
  SEARCH_VERB_CONFIG,
  scanArgsSkippingPattern,
};
