'use strict';
// body-sources.js: static analysis of where a `gh` issue/PR write takes its body
// from, shared by trailhead-secret-guard.js (#210). Nothing is ever executed: shell
// words are expanded the way bash would for a plain argument ($NAME, ${NAME}, a
// leading ~, variables set earlier in the command), redirects and flags are parsed,
// and a write's body is traced to files to read, text to scan, or a reason it cannot
// be known (the caller then fails closed). Best-effort, not a full shell parser.
// Self-contained: requires only node built-ins and the sibling gh-subcommand.js (dequote).

const fs = require('fs');
const path = require('path');
const { dequote, dequoteSpans } = require('./gh-subcommand.js');

const ASSIGN_TOKEN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

// --- static shell expansion (just enough to find a --body-file path) -----------

// Look a variable up: variables set earlier in the command first, then the hook's
// environment. null = unknown or recorded as unresolvable.
function lookupVar(name, vars, env) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  const v = env[name];
  return typeof v === 'string' ? v : null;
}

// Expand the `$...` at text[i]. Only $NAME and ${NAME} are understood; command
// substitution, parameter operators and positional/special params are unresolvable.
// Returns { value, next } or { unresolved }.
function expandDollar(text, i, vars, env) {
  const rest = text.slice(i + 1);
  let name;
  let len;
  const braced = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
  if (braced) {
    name = braced[1];
    len = braced[0].length;
  } else if (rest[0] === '{') {
    return { unresolved: 'parameter expansion operator' };
  } else if (rest[0] === '(') {
    return { unresolved: 'command substitution' };
  } else if (/^[0-9@*#?$!-]/.test(rest)) {
    return { unresolved: `special parameter $${rest[0]}` };
  } else {
    const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (!bare) return { value: '$', next: i + 1 }; // a lone $ is literal
    name = bare[0];
    len = name.length;
  }
  const v = lookupVar(name, vars, env);
  if (v === null) return { unresolved: `unknown variable ${name}` };
  return { value: v, next: i + 1 + len };
}

const ANSI_C_SIMPLE = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' };

// Decode the body of an ANSI-C `$'...'` span starting at word[i] (just past the
// opening quote). Common escapes are decoded (\n \t \\ \' \" \xHH \uHHHH \NNN); any
// other backslash pair keeps the character after it, so nothing is ever lost.
// Returns { value, next } or { unresolved }.
function expandAnsiC(word, i) {
  let out = '';
  for (;;) {
    if (i >= word.length) return { unresolved: 'unterminated quote' };
    const d = word[i];
    if (d === "'") return { value: out, next: i + 1 };
    if (d !== '\\' || i + 1 >= word.length) { out += d; i++; continue; }
    const rest = word.slice(i + 1);
    const n = rest[0];
    let m;
    if (Object.prototype.hasOwnProperty.call(ANSI_C_SIMPLE, n)) {
      out += ANSI_C_SIMPLE[n]; i += 2;
    } else if ((m = /^x([0-9a-fA-F]{1,2})/.exec(rest)) || (m = /^u([0-9a-fA-F]{1,4})/.exec(rest)) || (m = /^U([0-9a-fA-F]{1,8})/.exec(rest))) {
      const cp = parseInt(m[1], 16);
      out += cp <= 0x10ffff ? String.fromCodePoint(cp) : m[0];
      i += 1 + m[0].length;
    } else if ((m = /^[0-7]{1,3}/.exec(rest))) {
      out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
      i += 1 + m[0].length;
    } else {
      out += n; i += 2; // \\ \' \" and any other pair: keep the character
    }
  }
}

// Expand one shell word the way bash would for a plain argument: single quotes are
// literal, double quotes expand $NAME/${NAME} only, a bare word also expands a
// leading `~`/`~/` to HOME. Returns { value } or { unresolved: reason }.
function expandWord(word, vars, env) {
  let out = '';
  let i = 0;
  if (word[0] === '~') {
    if (word.length > 1 && word[1] !== '/') return { unresolved: 'user home (~user)' };
    const home = lookupVar('HOME', vars, env);
    if (home === null) return { unresolved: 'unknown variable HOME' };
    out = home;
    i = 1;
  }
  while (i < word.length) {
    const c = word[i];
    if (c === "'") {
      const close = word.indexOf("'", i + 1);
      if (close === -1) return { unresolved: 'unterminated quote' };
      out += word.slice(i + 1, close);
      i = close + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= word.length) return { unresolved: 'unterminated quote' };
        const d = word[i];
        if (d === '"') { i++; break; }
        if (d === '`') return { unresolved: 'command substitution' };
        if (d === '\\' && i + 1 < word.length) {
          const n = word[i + 1];
          out += '$`"\\'.includes(n) ? n : d + n;
          i += 2;
        } else if (d === '$') {
          const r = expandDollar(word, i, vars, env);
          if (r.unresolved) return r;
          out += r.value;
          i = r.next;
        } else {
          out += d;
          i++;
        }
      }
    } else if (c === '\\' && i + 1 < word.length) {
      out += word[i + 1];
      i += 2;
    } else if (c === '$' && word[i + 1] === "'") {
      // ANSI-C quoting: bash drops the `$` and decodes the span.
      const r = expandAnsiC(word, i + 2);
      if (r.unresolved) return r;
      out += r.value;
      i = r.next;
    } else if (c === '$' && word[i + 1] === '"') {
      i++; // locale quoting: drop the `$`, the double-quoted span follows
    } else if (c === '$') {
      const r = expandDollar(word, i, vars, env);
      if (r.unresolved) return r;
      out += r.value;
      i = r.next;
    } else if (c === '`') {
      return { unresolved: 'command substitution' };
    } else {
      out += c;
      i++;
    }
  }
  return { value: out };
}

// Quote-aware word splitter. Like shell-scan's tokenize, but a `$(...)`, `<(...)`,
// `>(...)` or backtick span stays inside ONE word even when it holds spaces.
function words(stmt) {
  const s = String(stmt).trim();
  const out = [];
  let cur = '';
  let quote = null; // ' or "
  let ansi = false; // inside a `$'...'` span
  let bare = false; // the previous char is a bare `$` (not escaped, not the 2nd of `$$`)
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const afterBare = bare;
    bare = false;
    if (quote) {
      // An ANSI-C `$'...'` span honours backslash escapes (`$'a\'b'`).
      if (quote === "'" && ansi && c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
      // Inside double quotes bash removes a backslash-newline continuation.
      if (quote === '"' && c === '\\' && s[i + 1] === '\n') { i++; bare = afterBare; continue; }
      cur += c;
      if (quote === '"' && c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === quote) { quote = null; ansi = false; }
      continue;
    }
    if (c === "'" || c === '"') { ansi = c === "'" && afterBare; quote = c; cur += c; continue; }
    // A backslash-newline continuation vanishes (`a\<nl>b` is `ab`, `a \<nl>b` is two words).
    if (c === '\\' && s[i + 1] === '\n') { i++; bare = afterBare; continue; } // the bare-dollar state carries over
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if ((c === '$' || c === '<' || c === '>') && s[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '`') {
      const close = s.indexOf('`', i + 1);
      const end = close === -1 ? s.length - 1 : close;
      cur += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    // A redirect operator glued to its neighbours (`cat >f<<'EOF'`, `echo x>f`)
    // starts a new word; a file-descriptor digit before it stays with the operator.
    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      if (cur && !/^\d+$/.test(cur)) { out.push(cur); cur = ''; }
      const op = /^(?:&>>|&>|<<<|<<-|<<|>>|>&|<&|>\||<>|>|<)/.exec(s.slice(i))[0];
      cur += op;
      i += op.length - 1;
      continue;
    }
    if (c === '$') bare = !afterBare; // `$$` is the PID: its 2nd `$` opens nothing
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// The command/process substitutions ($(...), `...`, and outside double quotes <(...)
// and >(...)) in some text: [{ start, end, inner }] (end exclusive). Single-quoted
// text is skipped, except with `literalQuotes` (heredoc text, where quotes are
// ordinary characters). An unclosed span runs to the end of the text.
function substitutionSpans(s, literalQuotes = false) {
  const out = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (c === '\\') { i++; continue; }
    if (!literalQuotes && c === "'") { inSingle = true; continue; }
    if (!literalQuotes && c === '"') { inDouble = !inDouble; continue; }
    if (s[i + 1] === '(' && (c === '$' || (!inDouble && !literalQuotes && (c === '<' || c === '>')))) {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      out.push({ start: i, end: Math.min(j + 1, s.length), inner: s.slice(i + 2, j) });
      i = j;
    } else if (c === '`') {
      const close = s.indexOf('`', i + 1);
      const end = close === -1 ? s.length : close;
      out.push({ start: i, end: Math.min(end + 1, s.length), inner: s.slice(i + 1, end) });
      i = end;
    }
  }
  return out;
}

// Expand heredoc text the way bash does for an unquoted delimiter: $NAME and ${NAME}
// expand, `\$`, `\`` and `\\` are escapes, quotes are ordinary characters.
function expandPlain(text, vars, env) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n') {
      i += 2; // a backslash-newline continuation vanishes
    } else if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      out += '$`\\'.includes(n) ? n : c + n;
      i += 2;
    } else if (c === '$') {
      const r = expandDollar(text, i, vars, env);
      if (r.unresolved) return r;
      out += r.value;
      i = r.next;
    } else if (c === '`') {
      return { unresolved: 'command substitution' };
    } else {
      out += c;
      i++;
    }
  }
  return { value: out };
}

// --- redirects and flags ----------------------------------------------------------

const REDIRECT_RE = /^(\d*)(<<<|<<-?|&>>|&>|>>|>\||>&|<&|<>|>|<)([\s\S]*)$/;

// Split a statement's words into plain arguments and redirections.
//   stdin: null | { type: 'heredoc' | 'here' } | { type: 'file', word }
//   outs:  [{ word, append }]  (stdout redirects; fd duplications like 2>&1 are dropped)
function parseRedirects(toks) {
  const args = [];
  const outs = [];
  let stdin = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = t.startsWith('<(') || t.startsWith('>(') ? null : REDIRECT_RE.exec(t);
    if (!m) { args.push(t); continue; }
    const [, fd, op, glued] = m;
    if (op === '>&' || op === '<&') { if (!glued) i++; continue; } // 2>&1, >&2: fd duplication
    const word = glued || toks[++i] || '';
    if (op === '<<' || op === '<<-') stdin = { type: 'heredoc' };
    else if (op === '<<<') stdin = { type: 'here', word };
    else if (op === '<' || op === '<>') stdin = { type: 'file', word };
    else if (fd === '' || fd === '1' || op.startsWith('&')) outs.push({ word, append: op.endsWith('>>') });
  }
  return { args, outs, stdin };
}

// A quoted or split token that is this flag (`'-F'`, `--body-fi""le`, `"--body-file=F"`,
// `"-F/p"`); free text in the flag's own quoted span (`"-F handling"`) is not (#219).
function dequotedFlag(raw, long, short) {
  const { text: d, spans } = dequoteSpans(raw);
  const hit = d === long || (short && d === short) || d.startsWith(`${long}=`) || (short && d.startsWith(`${short}=`));
  if (hit) return d;
  if (!short || !d.startsWith(short) || d.startsWith('--') || d.length <= short.length) return null;
  // The attached shorthand (`"-F/p"`, `-"F"/"p a"`, `"-F/my dir/b"`). Only a space DIRECTLY
  // after the flag letter, in the letter's own quoted span, is free text (`"-F handling"`).
  const next = short.length;
  if (/\s/.test(d[next]) && spans[next] !== -1 && spans[next] === spans[next - 1]) return null;
  return d;
}

// Values of a gh flag (long form, optional short form), in order: `--long v`,
// `--long=v`, `-s v`, `-s=v` and the attached pflag shorthand `-sv`.
function flagValues(args, long, short) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    // A quoted or split flag name is the same flag; the raw form is tried first so an
    // unquoted flag keeps its raw value (#219).
    const raw = args[i];
    const rawHit = raw === long || raw.startsWith(`${long}=`) || (short && raw.startsWith(short) && !raw.startsWith('--'));
    const t = rawHit ? raw : dequotedFlag(raw, long, short) || raw;
    if (t === long || (short && t === short)) {
      if (args[i + 1] !== undefined) out.push(args[++i]);
    } else if (t.startsWith(`${long}=`)) out.push(t.slice(long.length + 1));
    else if (short && t.startsWith(`${short}=`)) out.push(t.slice(short.length + 1));
    else if (short && t.startsWith(short) && !t.startsWith('--') && t.length > 2) out.push(t.slice(2));
  }
  return out;
}

// Resolve one shell word that names a file to an absolute path, without running
// anything: { path } or { unresolved }. See resolveBodyFile for the cwd contract.
function resolveWord(raw, vars, env, cwd) {
  if (raw.startsWith('<(') || raw.startsWith('>(')) return { unresolved: 'process substitution' };
  const r = expandWord(raw, vars, env);
  if (r.unresolved) return { unresolved: r.unresolved };
  return resolveExpanded(r.value, cwd);
}

// Same for an already-expanded value (e.g. the path after `body=@`).
function resolveExpanded(value, cwd) {
  if (path.isAbsolute(value)) return { path: path.normalize(value) };
  if (cwd === null) return { unresolved: 'relative path after cd (working directory unknown)' };
  return { path: path.resolve(cwd === undefined ? process.cwd() : cwd, value) };
}

const STDIN_PATHS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

// --- where a write's body comes from -----------------------------------------------

const basenameOf = (w) => String(w || '').replace(/^.*\//, '');
const INLINE_PRODUCERS = new Set(['echo', 'printf', 'true', ':']);

// Body sources are a list of items:
//   { text }        content to scan that is not in the command string (an expanded value)
//   { path }        a file to read and scan
//   { unresolved }  a source that cannot be known statically: block
// Content that is already inside the command string (heredoc, herestring, echo/printf
// arguments) needs no item: the whole command is scanned.

const unresolvedItem = (reason) => [{ unresolved: reason }];
// An unresolvable expansion in inline text (not a file path): the caller words its block differently.
const inlineUnresolved = (reason) => [{ unresolved: reason, inline: true }];

// Items for a file named by a shell word, as seen from statement `rec`.
function wordItems(word, rec, ctx) {
  const r = resolveWord(word, rec.vars, ctx.env, rec.cwdKnown ? ctx.cwd : null);
  return r.unresolved ? unresolvedItem(r.unresolved) : fileItems(r.path, rec.index, ctx);
}

// Items for reading the file `p` as of statement index `before`. A file an earlier
// statement of the same command writes (and that is recognised: a redirect fed by
// inline content or by cat, tee, cp) has the content of its source, not whatever is
// (or is not) on disk now; unrecognised writers are not counted, so the file must
// exist and is read.
function fileItems(p, before, ctx) {
  if (p === '/dev/null') return []; // an empty body: nothing to scan
  const writers = [];
  for (let i = 0; i < before; i++) {
    const rec = ctx.history[i];
    if (rec.sep === '&') continue; // backgrounded: may not have run yet
    for (const t of writerTargets(rec, ctx)) if (t.path === p) writers.push(t);
  }
  if (writers.length === 0) return [{ path: p }];
  const items = writers.flatMap((t) => t.content);
  if (writers.some((t) => t.append)) items.push({ path: p, optional: true }); // keeps what was there
  return items;
}

// Content a `cmd > file` redirect puts in the file, or null when not recognised.
function redirectContent(cmd0, rest, rec, ctx) {
  if (!cmd0) return [];
  if (INLINE_PRODUCERS.has(cmd0)) return rest.flatMap((a) => valueItems(a, rec, ctx));
  if (cmd0 === 'cat') {
    const files = rest.filter((a) => !a.startsWith('-'));
    return files.length ? files.flatMap((f) => wordItems(f, rec, ctx)) : stdinContent(rec, ctx);
  }
  return null;
}

// The files a statement writes and what it writes into them:
// [{ path, append, content: items }]. Only the recognised shapes: a stdout
// redirect of cat/echo/printf (or nothing), `tee [-a] path`, and `cp src dst`.
function writerTargets(rec, ctx) {
  const red = parseRedirects(words(rec.text));
  let k = 0;
  while (k < red.args.length && ASSIGN_TOKEN_RE.test(red.args[k])) k++;
  const cmd0 = basenameOf(red.args[k]);
  const rest = red.args.slice(k + 1);
  const cwd = rec.cwdKnown ? ctx.cwd : null;
  const target = (word) => {
    const r = resolveWord(word, rec.vars, ctx.env, cwd);
    return r.unresolved ? null : r.path;
  };
  const out = [];
  if (red.outs.length) {
    const content = redirectContent(cmd0, rest, rec, ctx);
    if (content) {
      for (const o of red.outs) {
        const t = target(o.word);
        if (t) out.push({ path: t, append: o.append, content });
      }
    }
  }
  if (cmd0 === 'tee') {
    const content = stdinContent(rec, ctx);
    if (content) {
      const append = rest.includes('-a') || rest.includes('--append');
      for (const f of rest.filter((a) => !a.startsWith('-'))) {
        const t = target(f);
        if (t) out.push({ path: t, append, content });
      }
    }
  }
  if (cmd0 === 'cp') {
    const operands = rest.filter((a) => !a.startsWith('-'));
    const dst = operands.length === 2 ? target(operands[1]) : null;
    if (dst) out.push({ path: dst, append: false, content: wordItems(operands[0], rec, ctx) });
  }
  return out;
}

// What a statement feeds to its stdin: items, or null when there is no stdin source.
function stdinContent(rec, ctx) {
  const red = parseRedirects(words(rec.text));
  if (red.stdin) {
    if (red.stdin.type === 'file') return wordItems(red.stdin.word, rec, ctx);
    if (red.stdin.type === 'here') return valueItems(red.stdin.word, rec, ctx);
    return heredocItems(rec, ctx);
  }
  const prev = ctx.history[rec.index - 1];
  if (prev && prev.sep === '|') return producerItems(prev, ctx);
  return null;
}

// What a pipeline producer writes to stdout.
function producerItems(rec, ctx) {
  const { args } = parseRedirects(words(rec.text));
  let k = 0;
  while (k < args.length && ASSIGN_TOKEN_RE.test(args[k])) k++;
  const cmd0 = basenameOf(args[k]);
  if (INLINE_PRODUCERS.has(cmd0)) return args.slice(k + 1).flatMap((a) => valueItems(a, rec, ctx));
  if (cmd0 === 'cat') {
    const files = args.slice(k + 1).filter((a) => !a.startsWith('-'));
    if (files.length) return files.flatMap((f) => wordItems(f, rec, ctx));
    return stdinContent(rec, ctx) || unresolvedItem('cat reads a stdin the guard cannot see');
  }
  return unresolvedItem(`the body is piped from ${cmd0 || 'a command'}`);
}

// Items for text whose `$...` and backticks the shell would expand: a --body value,
// an echo/printf argument, a herestring, an unquoted heredoc body (`literalQuotes`).
// Substitutions of `cat path`/`<path` are read, `cat <<EOF` follows the heredoc,
// $VAR is expanded, and anything else is unresolvable. Literal text needs no item:
// the whole command is scanned.
function valueItems(raw, rec, ctx, literalQuotes = false) {
  if (!/[$`]/.test(raw) || (!literalQuotes && /^'[\s\S]*'$/.test(raw))) return [];
  const items = [];
  let rest = '';
  let at = 0;
  for (const sp of substitutionSpans(raw, literalQuotes)) {
    rest += raw.slice(at, sp.start);
    at = sp.end;
    items.push(...substitutionItems(sp.inner, rec, ctx));
  }
  rest += raw.slice(at);
  if (/[$`]/.test(rest)) {
    const r = literalQuotes ? expandPlain(rest, rec.vars, ctx.env) : expandWord(rest, rec.vars, ctx.env);
    items.push(...(r.unresolved ? inlineUnresolved(r.unresolved) : [{ text: r.value }]));
  }
  return items;
}

// Items for one `$(inner)` / `inner` substitution.
function substitutionItems(inner, rec, ctx) {
  const t = inner.trim();
  const h = /^cat\s+<<-?\s*(['"]?)\w+\1$/.exec(t);
  if (h) return h[1] ? [] : heredocItems(rec, ctx); // a quoted delimiter is literal text
  const m = /^cat\s+(\S+)$/.exec(t) || /^<\s*(\S+)$/.exec(t);
  if (m) return wordItems(m[1], rec, ctx);
  return inlineUnresolved('command substitution in the body');
}

// Items for the unquoted heredoc bodies of a statement (the shell expands them).
function heredocItems(rec, ctx) {
  return (rec.heredocs || []).filter((h) => !h.quoted).flatMap((h) => valueItems(h.body, rec, ctx, true));
}

// Every body source of one write: { items }.
function bodySources(w, ctx) {
  const rec = w.history[w.index];
  const { args } = parseRedirects(words(w.text));
  const stdinItems = () => stdinContent(rec, ctx) || [];
  const fileArg = (raw) => (STDIN_PATHS.has(raw) ? stdinItems() : wordItems(raw, rec, ctx));
  const items = [];
  if (w.kind === 'api') {
    // Every `body=` field: -F/--field may read a file (`body=@path`, `body=@-`); for
    // -f/--raw-field `@` is literal. Any other value is inline text, expanded and scanned.
    const fields = [
      ...flagValues(args, '--field', '-F').map((raw) => ({ raw, fileOk: true })),
      ...flagValues(args, '--raw-field', '-f').map((raw) => ({ raw, fileOk: false })),
    ];
    for (const { raw, fileOk } of fields) {
      const key = dequote(raw); // `'body'=x`, `bo""dy=x` name the same field (#219)
      if (!key.startsWith('body=')) continue;
      if (!(fileOk && key.startsWith('body=@'))) { items.push(...valueItems(raw, rec, ctx)); continue; }
      const r = expandWord(raw, rec.vars, ctx.env);
      if (r.unresolved) { items.push(...unresolvedItem(r.unresolved)); continue; }
      const file = r.value.slice('body=@'.length);
      if (STDIN_PATHS.has(file)) { items.push(...stdinItems()); continue; }
      const res = resolveExpanded(file, rec.cwdKnown ? ctx.cwd : null);
      items.push(...(res.unresolved ? unresolvedItem(res.unresolved) : fileItems(res.path, rec.index, ctx)));
    }
    for (const raw of flagValues(args, '--input', null)) items.push(...fileArg(raw));
    return items;
  }
  const files = flagValues(args, '--body-file', '-F');
  // gh keeps the last one, but scanning every occurrence is the safe direction.
  for (const raw of files) items.push(...fileArg(raw));
  for (const raw of flagValues(args, '--body', '-b')) items.push(...valueItems(raw, rec, ctx));
  return items;
}

// What bash sees once `\<newline>` continuations are removed, for the statements of
// one command: each statement's text (already joined outside single quotes, which
// stay literal) and its unquoted heredoc bodies. The raw command still has a token
// broken by a continuation, so the caller scans this too (#215).
function joinedText(history) {
  const parts = [];
  for (const rec of history) {
    parts.push(rec.text);
    for (const h of rec.heredocs || []) {
      if (!h.quoted && h.body.includes('\\\n')) parts.push(h.body.split('\\\n').join(''));
    }
  }
  return parts;
}

// Literal quote removal for a word that cannot be expanded: drop the ' and "
// characters and keep the rest, so literal halves around an unresolvable piece join.
const stripQuoteChars = (word) => word.replace(/\$(?=['"])/g, '').replace(/['"]/g, '');


// What bash passes as each word once adjacent quoted parts are concatenated
// (`"a""b"`, `"a"b`, `a''b`), for the statements of one command. An unresolvable
// word falls back to literal quote removal; blocking on it is left to the body
// sources. Variables are deliberately not expanded (empty scope): a `$NAME` stays
// literal here, so an env value is never pulled into a field the guard does not
// scan (valueItems expands those a body takes). The raw command keeps the quotes
// between the halves, so the caller scans this too (#217).
function resolvedWords(history) {
  const out = [];
  for (const rec of history) {
    for (const word of words(rec.text)) {
      const r = expandWord(word, {}, {});
      out.push(r.unresolved ? stripQuoteChars(word) : r.value);
    }
  }
  return out;
}

// Read a body file (regular files only: a FIFO or device could hang the hook).
// `optional` tolerates a missing file.
function readBodyFile(p, optional) {
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    if (optional && e.code === 'ENOENT') return '';
    throw e;
  }
  if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
  return fs.readFileSync(p, 'utf8').slice(0, 1_000_000);
}

module.exports = {
  ASSIGN_TOKEN_RE,
  STDIN_PATHS,
  words,
  expandWord,
  parseRedirects,
  flagValues,
  resolveWord,
  resolveExpanded,
  substitutionSpans,
  expandPlain,
  joinedText,
  resolvedWords,
  stripQuoteChars,
  dequote,
  bodySources,
  readBodyFile,
};
