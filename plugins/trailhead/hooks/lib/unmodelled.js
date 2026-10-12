'use strict';
// unmodelled.js: the ONE closed list of shell constructs the secret-guard, the
// body-guard and the secret-read guard cannot interpret with certainty (#227).
// The threat model of those guards is the ACCIDENTAL leak: a construct they cannot
// follow is not emulated (the emulation of #210-#220 stays as it is), it is blocked
// with a "rewrite it in a simple form" message, but only when it can matter to the
// guard that looks at it.
//
// This module finds the constructs and the code each one hides; it does NOT decide
// what a gh write is. Every hit carries what a guard needs (`stmt`, `payload`,
// `after`, `calls`, `reach`) and each guard judges relevance with its OWN write
// classifier, passed to firstRelevant (secret-guard: ghWrites, body-guard:
// ghBodyWrites; the read guard looks for a secret-looking piece itself), so there is
// no second classifier to drift. Best-effort like the guards: not a shell parser.
// Self-contained: requires only the sibling libs.

const {
  splitStatementsWithSeparators,
  substitutionBodies,
  heredocBodies,
  heredocSubstitutionBodies,
  functionSubstitutions,
  inWordContinuations,
} = require('./shell-scan.js');
const { words, ASSIGN_TOKEN_RE } = require('./body-sources.js');
const { parseGhSubcommand, dequote } = require('./gh-subcommand.js');

// The closed list. `reach` says what makes a hit relevant to a guard:
//   payload  the code it hides holds a write (eval, funsub), or the construct is
//            CALLED later and what it runs holds a write (function, alias);
//   state    a write comes AFTER it (source, printf -v: they change what the later
//            write sees);
//   local    its own statement (with its pipeline) is a write;
//   self     the construct is itself a body-field write (a quoted gh api key).
const UNMODELLED = {
  eval: { label: 'eval', reach: 'payload', hint: 'call gh directly, not through eval, with the body in a file passed by its literal absolute path' },
  source: { label: 'source / `.`', reach: 'state', hint: 'run the sourced steps in a separate Bash call first, then post with a literal --body-file path' },
  funsub: { label: 'a function substitution (`${ cmd; }`)', reach: 'payload', hint: 'use a plain $(...) command substitution or a separate command' },
  'printf-v': { label: 'printf -v', reach: 'state', hint: 'put the text in a file, or in a single-quoted literal' },
  function: { label: 'a function definition', reach: 'payload', hint: 'call gh directly, not through a function defined in the same command' },
  alias: { label: 'alias', reach: 'payload', hint: 'call gh directly, not through an alias' },
  'api-field': { label: 'a quoted or split gh api body field name', reach: 'self', hint: 'write the field plainly: `-f body=...` or `-f "body=..."`' },
  continuation: { label: 'a backslash-newline inside a word', reach: 'local', hint: 'keep every word on one line (a trailing backslash may only sit between words)' },
};

const MAX_DEPTH = 32;
const MAX_BYTES = 64 * 1024;
const SAMPLE_MAX = 80;

// --- command word ----------------------------------------------------------------

const LEADERS = new Set(['!', '{', '(', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time']);
const WRAPPER_VALUE_FLAGS = {
  env: ['-u', '-C', '-S'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R'],
  nice: ['-n'],
  timeout: ['-k', '-s'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
};

// Index just past a wrapper's own flags (and assignments), from the wrapper at toks[k].
function skipWrapper(toks, k) {
  const w = dequote(toks[k]);
  let j = k + 1;
  while (j < toks.length) {
    const t = dequote(toks[j]);
    if (WRAPPER_VALUE_FLAGS[w].includes(t)) j += 2;
    else if (t.startsWith('-')) j++;
    else if ((w === 'env' || w === 'sudo') && ASSIGN_TOKEN_RE.test(t)) j++;
    else break;
  }
  if (w === 'timeout' && j < toks.length) j++; // the duration
  return j;
}

// The words of a statement from its command word on: reserved words, a leading `(`,
// NAME=v prefixes, case heads and arm patterns and wrappers are skipped. So the
// word `eval` in `--body 'use eval here'` is never a command word.
function commandInfo(text) {
  let toks = words(text);
  while (toks.length) {
    const open = /^\(+/.exec(toks[0]);
    if (open) { toks = toks[0].length > open[0].length ? [toks[0].slice(open[0].length), ...toks.slice(1)] : toks.slice(1); continue; }
    const d = dequote(toks[0]);
    if (LEADERS.has(d) || ASSIGN_TOKEN_RE.test(toks[0])) { toks = toks.slice(1); continue; }
    if (d === 'case' && toks.includes('in')) { toks = toks.slice(toks.indexOf('in') + 1); continue; }
    if (/^[^\s()$"'`]*\)$/.test(toks[0])) { toks = toks.slice(1); continue; } // case arm pattern)
    if (Object.prototype.hasOwnProperty.call(WRAPPER_VALUE_FLAGS, d)) { toks = toks.slice(skipWrapper(toks, 0)); continue; }
    break;
  }
  return { toks, cmd: toks.length ? dequote(toks[0]) : '', args: toks.slice(1) };
}

const NAME_RE = /^[A-Za-z_][\w.:+-]*$/;

// The name a statement defines as a function (`f()`, `f(){`, `f ()`, `function f`), or null.
function functionHeadName(toks) {
  if (!toks.length) return null;
  const glued = /^([A-Za-z_][\w.:+-]*)\(\)/.exec(toks[0]);
  if (glued) return glued[1];
  if (NAME_RE.test(toks[0]) && toks[1] && /^\(\)/.test(toks[1])) return toks[0];
  if (toks[0] === 'function' && toks[1]) {
    const name = toks[1].replace(/\(\)\{?$/, '');
    return NAME_RE.test(name) ? name : null;
  }
  return null;
}

// --- per-construct helpers -------------------------------------------------------

const compact = (t) => String(t).replace(/\s+/g, ' ').trim();

// The statements, from entries[idx], that make up a function body: up to the closing
// `}` of the first brace group, or just the head statement when none opens there.
function functionBody(entries, idx) {
  const parts = [];
  let depth = 0;
  let opened = false;
  for (let j = idx; j < entries.length; j++) {
    parts.push(entries[j].text);
    for (const w of words(entries[j].text)) {
      if (w === '{' || /^\S+\(\)\{$/.test(w)) { depth++; opened = true; } else if (w === '}') depth--;
    }
    if (!opened || depth <= 0) break;
  }
  return parts.join('\n');
}

// The later statements that call `name` as a command word (also through a command
// substitution in them): [{ text, args }].
function callsOf(name, entries, idx) {
  const calls = [];
  const scan = (text) => {
    const info = commandInfo(text);
    if (info.cmd === name) calls.push({ text, args: info.args });
  };
  for (const e of entries.slice(idx + 1)) {
    scan(e.text);
    for (const body of substitutionBodies(e.text)) {
      for (const inner of splitStatementsWithSeparators(body)) scan(inner.text);
    }
  }
  return calls;
}

const API_FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);

// A `gh api` statement with a body field whose key is `body` once quotes are removed
// but is not written as the bare key (`'body'=`, `bo""dy=`, `b\ody=`). A fully quoted
// pair (`-f "body=x"`, `-f 'body=x'`) is the plain form.
function hasQuotedBodyField(toks) {
  const parsed = parseGhSubcommand(toks.join(' '));
  if (!parsed || parsed.sub !== 'api') return false;
  for (let k = 0; k < toks.length; k++) {
    const flag = dequote(toks[k]);
    let raw = null;
    if (API_FIELD_FLAGS.has(flag)) raw = toks[++k];
    else if (/^--(?:raw-)?field=/.test(flag)) raw = toks[k].slice(toks[k].indexOf('=') + 1);
    else if (/^-[fF]./.test(toks[k])) raw = toks[k].slice(2);
    if (raw === null || raw === undefined) continue;
    const value = dequote(raw);
    if (value.slice(0, value.indexOf('=')) !== 'body' || value.indexOf('=') < 0) continue;
    const plain = /^body=/.test(raw) || /^"body=(?:[^"\\]|\\[\s\S])*"$/.test(raw) || /^'body=[^']*'$/.test(raw);
    if (!plain) return true;
  }
  return false;
}

// printf with a -v option before its format.
function printfAssigns(args) {
  for (const a of args) {
    const d = dequote(a);
    if (d === '--' || !d.startsWith('-')) return false;
    if (d.startsWith('-v')) return true;
  }
  return false;
}

// --- the walk --------------------------------------------------------------------

function makeHit(id, fields) {
  const { label, hint, reach } = UNMODELLED[id];
  return { id, label, hint, reach, sample: '', stmt: '', stmtIndex: -1, payload: '', name: '', calls: [], after: '', ...fields };
}

// Hits that belong to one statement (its command word and what it defines).
function statementHits(entries, idx) {
  const e = entries[idx];
  const { toks, cmd, args } = commandInfo(e.text);
  const base = { stmt: e.text, stmtIndex: idx, sample: compact(e.text), after: entries.slice(idx + 1).map((x) => x.text).join('\n') };
  const fnName = functionHeadName(toks);
  if (fnName) {
    return [makeHit('function', { ...base, name: fnName, payload: functionBody(entries, idx), calls: callsOf(fnName, entries, idx).map((c) => c.text) })];
  }
  if (cmd === 'eval') return [makeHit('eval', { ...base, payload: args.map(dequote).join(' ') })];
  if (cmd === 'source' || cmd === '.') return [makeHit('source', base)];
  if (cmd === 'printf' && printfAssigns(args)) return [makeHit('printf-v', { ...base, payload: args.map(dequote).join(' ') })];
  if (cmd === 'alias') {
    const defs = args.map(dequote).filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]);
    const calls = defs.flatMap(([name, value]) => callsOf(name, entries, idx).map((c) => `${value} ${c.args.join(' ')}`.trim()));
    return [makeHit('alias', { ...base, name: defs.length ? defs[0][0] : '', payload: defs.map((d) => d[1]).join('\n'), calls })];
  }
  if (cmd && hasQuotedBodyField(toks)) return [makeHit('api-field', base)];
  return [];
}

// The pipeline a statement belongs to, joined (`a | b | c`).
function pipelineText(entries, idx) {
  let from = idx;
  let to = idx;
  while (from > 0 && entries[from - 1].sep === '|') from--;
  while (to < entries.length - 1 && entries[to].sep === '|') to++;
  return entries.slice(from, to + 1).map((x) => x.text).join(' | ');
}

function continuationHits(text, entries) {
  return inWordContinuations(text).map(({ junction }) => {
    const idx = entries.findIndex((e) => e.text.includes(junction));
    const stmt = idx < 0 ? text : pipelineText(entries, idx);
    return makeHit('continuation', { stmt, stmtIndex: idx, sample: compact(stmt) });
  });
}

// Every unmodelled construct in a command, including those inside command
// substitutions, backtick spans and unquoted heredoc bodies (depth- and size-capped).
function findUnmodelled(cmd) {
  const out = [];
  const work = [{ text: String(cmd), depth: 0 }];
  let bytes = 0;
  for (let w = 0; w < work.length; w++) {
    const { text, depth } = work[w];
    if (depth > 0) bytes += text.length;
    if (depth > MAX_DEPTH || bytes > MAX_BYTES) continue;
    const entries = splitStatementsWithSeparators(text);
    entries.forEach((_, idx) => out.push(...statementHits(entries, idx)));
    for (const f of functionSubstitutions(text)) {
      out.push(makeHit('funsub', { payload: f.payload, sample: compact('${' + f.payload + '}'), stmt: compact(f.payload) }));
    }
    out.push(...continuationHits(text, entries));
    for (const body of substitutionBodies(text)) work.push({ text: body, depth: depth + 1 });
    for (const doc of heredocBodies(text)) {
      if (doc.quoted) continue;
      for (const body of heredocSubstitutionBodies(doc.body)) work.push({ text: body, depth: depth + 1 });
    }
  }
  return out;
}

// --- relevance, per hit, by the construct's reach ----------------------------------

// `isWrite(text)` is the CALLING guard's own write classifier.
function isRelevant(hit, isWrite) {
  switch (hit.id) {
    case 'eval':
    case 'funsub': return isWrite(hit.payload);
    case 'function': return hit.calls.length > 0 && isWrite(hit.payload);
    case 'alias': return hit.calls.some((c) => isWrite(c));
    case 'source':
    case 'printf-v': return hit.after !== '' && isWrite(hit.after);
    case 'continuation': return isWrite(hit.stmt);
    default: return true; // api-field: the statement is itself a body write
  }
}

function firstRelevant(hits, isWrite) {
  return hits.find((h) => isRelevant(h, isWrite)) || null;
}

// --- the message -----------------------------------------------------------------

// `redact(text)` must strip anything secret-looking from the sample; without one the
// sample is withheld, so a token is never echoed back.
function unmodelledReason(guard, what, hit, redact) {
  const sample = typeof redact === 'function' ? redact(String(hit.sample)).slice(0, SAMPLE_MAX) : '';
  return `trailhead ${guard}: this command uses ${hit.label}${sample ? ` (\`${sample}\`)` : ''}, which the guard cannot ` +
    `interpret with certainty, so it cannot verify ${what}. Rewrite it in a simple form: ${hit.hint}.`;
}

module.exports = { UNMODELLED, findUnmodelled, firstRelevant, unmodelledReason };
