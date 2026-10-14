#!/usr/bin/env node
'use strict';
// trailhead report status check (self-contained, ships in templates/ so it reaches
// every install channel). Checks the leading `status:` line of an engine-agent
// report (Code review, Goal-backward verification #250; executor, fix, plan, debug,
// research, codebase-map #249) before the engine branches on it, and returns the
// report's fields.
//
// CLI:
//   node trailhead-report-status.js --technique <technique> [--file <path>]
// <technique> is verify | code-review | executor | fix | plan | debug | research |
// codebase-map. Reads the report from --file, or from stdin when there is none.
// Prints exactly one JSON line {"action","verdict","problem","report","fields","body"}:
//   action   accept | normalise | reask
//   verdict  the canonical token, or null on reask
//   problem  null | missing | unknown-token | conflicting | counts | fields (null iff not reask)
//   report   the original text on accept and reask; the normalised text on normalise
//   fields   label -> trimmed value for the report's fields (executor, fix, plan, debug,
//            research, codebase-map); {} for verify and code-review; null on reask
//   body     plan with `ready` only: the normalised report without its status line, the
//            PLAN to post verbatim; null otherwise
// Exit 0 for all three actions; exit 2 on a usage error (missing or unknown
// technique, unknown flag, missing or unreadable file) with {"error": "..."} on
// stderr and nothing on stdout.
//
// The rules, in short: a candidate status line is outside code fences and
// blockquotes and not indented as code; after stripping a heading, list bullet and
// bold/underscore/backtick decoration it reads `status: <token>` where the token,
// lower-cased with spaces and hyphens as underscores, is exactly one of the
// technique's closed set. One valid token in the exact layout (status on line 1;
// for code-review also the counts line on line 2) is accepted; the same token in
// any other layout is normalised; anything else is a reask, never a guess.
// Fields: a field starts at a top-level line (same rules as a status line) reading
// `<label>:` after the same stripping; its value is the rest of that line plus every
// following line up to the next field label or the end. Labels are a closed list per
// family, matched case-insensitively; an empty value or `none` means none. A required
// field missing, a label given twice or a broken invariant is the `fields` problem.
// Problem precedence on mixed defects: missing > conflicting > unknown-token > counts > fields.

const fs = require('fs');

const frozen = (a) => Object.freeze([...a]);

// Hard-coded here; report-status.test.js asserts these equal the tokens parsed
// from skills/_shared/techniques/{verify,code-review}.md, which stay the source.
const REVIEW_TOKENS = Object.freeze({
  verify: frozen(['met', 'gaps_found', 'inconclusive']),
  'code-review': frozen(['clean', 'issues_found']),
});

// The return contract of each field family. Hard-coded here (the checker ships
// self-contained); report-status.test.js asserts these equal what scripts/agent-blocks.md
// states. An invariant says: for these statuses the field (or `body`, the report without
// its status line) is `none` / `non-empty`.
const CONTRACTS = Object.freeze({
  implementing: Object.freeze({
    tokens: frozen(['done', 'partial', 'blocked']),
    required: frozen(['commits', 'tests', 'deviations', 'blockers']),
    optional: frozen(['fidelity', 'surfaced scope']),
    invariants: Object.freeze([
      Object.freeze({ when: frozen(['done']), field: 'blockers', rule: 'none' }),
      Object.freeze({ when: frozen(['partial', 'blocked']), field: 'blockers', rule: 'non-empty' }),
    ]),
  }),
  investigating: Object.freeze({
    tokens: frozen(['found', 'inconclusive', 'needs_input']),
    required: frozen(['answer', 'evidence', 'open questions']),
    optional: frozen([]),
    invariants: Object.freeze([
      Object.freeze({ when: frozen(['needs_input']), field: 'open questions', rule: 'non-empty' }),
    ]),
  }),
  plan: Object.freeze({
    tokens: frozen(['ready', 'needs_input']),
    required: frozen([]),
    optional: frozen(['questions']),
    invariants: Object.freeze([
      Object.freeze({ when: frozen(['ready']), field: 'body', rule: 'non-empty' }),
      Object.freeze({ when: frozen(['needs_input']), field: 'questions', rule: 'non-empty' }),
    ]),
  }),
});

// Technique -> field family.
const FAMILY_OF = Object.freeze({
  executor: 'implementing',
  fix: 'implementing',
  debug: 'investigating',
  research: 'investigating',
  'codebase-map': 'investigating',
  plan: 'plan',
});

// Technique -> its closed set of status tokens.
const TOKENS = Object.freeze({
  ...REVIEW_TOKENS,
  ...Object.fromEntries(Object.entries(FAMILY_OF).map(([t, f]) => [t, CONTRACTS[f].tokens])),
});

const COUNTS_RE = /^critical\s*:\s*(\d+)\s*·\s*warning\s*:\s*(\d+)\s*·\s*info\s*:\s*(\d+)$/i;
const BOM = '﻿';

// Heading marks, a list bullet and bold/underscore/backtick decoration removed.
function strip(line) {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

// Index set of the lines that may carry a status or counts line: outside fenced
// code blocks, outside blockquotes, not indented as code (4+ spaces or a tab).
function candidateLines(lines) {
  const out = [];
  let fence = null; // { char, len } while inside a fenced block
  lines.forEach((line, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      return;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      return;
    }
    if (/^(?: {4,}|\t)/.test(line)) return;
    if (/^ {0,3}>/.test(line)) return;
    out.push(i);
  });
  return out;
}

function statusOf(line) {
  const s = strip(line);
  const m = /^status\s*:(.*)$/i.exec(s);
  if (!m) return null;
  return m[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function countsOf(line) {
  const m = COUNTS_RE.exec(strip(line));
  return m ? `critical: ${m[1]} · warning: ${m[2]} · info: ${m[3]}` : null;
}

const reask = (text, problem) => ({ action: 'reask', verdict: null, problem, report: text, fields: null, body: null });

const isNone = (v) => v === undefined || /^(none\.?)?$/i.test(v.trim());

// The fields of a report: label -> trimmed value, over the top-level lines that are not
// status lines. Returns { fields, duplicate }.
function parseFields(lines, cands, skip, contract) {
  const allowed = new Set([...contract.required, ...contract.optional]);
  const hits = [];
  for (const i of cands) {
    if (skip.has(i)) continue;
    const m = /^([A-Za-z][A-Za-z ]*?)\s*:(.*)$/.exec(strip(lines[i]));
    const label = m && m[1].replace(/\s+/g, ' ').toLowerCase();
    if (label && allowed.has(label)) hits.push({ i, label, first: m[2].trim() });
  }
  const fields = {};
  let duplicate = false;
  hits.forEach((h, k) => {
    const end = k + 1 < hits.length ? hits[k + 1].i : lines.length;
    const tail = [];
    for (let j = h.i + 1; j < end; j++) if (!skip.has(j)) tail.push(lines[j]);
    if (Object.prototype.hasOwnProperty.call(fields, h.label)) duplicate = true;
    else fields[h.label] = [h.first, ...tail].join('\n').trim();
  });
  return { fields, duplicate };
}

// The fields problem for a verdict, or null when the contract holds.
function fieldsProblem(contract, verdict, fields, duplicate, body) {
  if (duplicate) return true;
  if (contract.required.some((f) => !Object.prototype.hasOwnProperty.call(fields, f))) return true;
  return contract.invariants.some((inv) => {
    if (!inv.when.includes(verdict)) return false;
    const value = inv.field === 'body' ? body : fields[inv.field];
    return inv.rule === 'none' ? !isNone(value) : isNone(value);
  });
}

function checkReport(text, technique) {
  const tokens = Object.prototype.hasOwnProperty.call(TOKENS, technique) ? TOKENS[technique] : null;
  if (!tokens) throw new Error(`unknown technique: ${technique}`);
  const original = typeof text === 'string' ? text : '';
  const hasBom = original.startsWith(BOM);
  const lines = (hasBom ? original.slice(1) : original).replace(/\r\n?/g, '\n').split('\n');
  const cleanLayout = !hasBom && !original.includes('\r');

  const cands = candidateLines(lines);
  const statusLines = cands.map((i) => ({ i, token: statusOf(lines[i]) })).filter((c) => c.token !== null);
  if (statusLines.length === 0) return reask(original, 'missing');

  const valid = new Set(statusLines.filter((c) => tokens.includes(c.token)).map((c) => c.token));
  const anyInvalid = statusLines.some((c) => !tokens.includes(c.token));
  if (valid.size > 1 || (valid.size === 1 && anyInvalid)) return reask(original, 'conflicting');
  if (valid.size === 0) return reask(original, 'unknown-token');
  const verdict = [...valid][0];

  let counts = [];
  if (technique === 'code-review') {
    counts = cands.map((i) => ({ i, text: countsOf(lines[i]) })).filter((c) => c.text !== null);
    if (counts.length !== 1) return reask(original, 'counts');
  }

  // Blank lines that led the original are not content: drop them with the status lines.
  const lead = lines.findIndex((l) => l.trim() !== '');
  const drop = new Set([...statusLines, ...counts].map((c) => c.i));
  const rest = lines.filter((_, i) => !drop.has(i) && i >= lead);

  let fields = {};
  let body = null;
  const family = Object.prototype.hasOwnProperty.call(FAMILY_OF, technique) ? FAMILY_OF[technique] : null;
  if (family) {
    const contract = CONTRACTS[family];
    const statusIdx = new Set(statusLines.map((c) => c.i));
    const parsed = parseFields(lines, cands, statusIdx, contract);
    const text = rest.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
    if (fieldsProblem(contract, verdict, parsed.fields, parsed.duplicate, text)) return reask(original, 'fields');
    fields = parsed.fields;
    if (family === 'plan' && verdict === 'ready') body = text;
  }

  const exact = cleanLayout && statusLines.length === 1 && statusLines[0].i === 0 && lines[0] === `status: ${verdict}`
    && (counts.length === 0 || (counts[0].i === 1 && lines[1] === counts[0].text));
  if (exact) return { action: 'accept', verdict, problem: null, report: original, fields, body };

  const head = [`status: ${verdict}`, ...counts.map((c) => c.text)];
  return { action: 'normalise', verdict, problem: null, report: [...head, ...rest].join('\n'), fields, body };
}

function parseArgs(argv) {
  const opts = { technique: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--technique' || a === '--file') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a === '--technique' ? 'technique' : 'file'] = v;
      i++;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.technique) throw new Error(`--technique <${Object.keys(TOKENS).join('|')}> is required`);
  if (!Object.prototype.hasOwnProperty.call(TOKENS, opts.technique)) throw new Error(`unknown technique: ${opts.technique}`);
  return opts;
}

function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const readFile = io.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const readStdin = io.readStdin || (() => fs.readFileSync(0, 'utf8'));
  let result;
  try {
    const opts = parseArgs(argv);
    const text = opts.file !== null ? readFile(opts.file) : readStdin();
    result = checkReport(text, opts.technique);
  } catch (e) {
    stderr.write(`${JSON.stringify({ error: e.message })}\n`);
    return 2;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

// exitCode, not process.exit(): exiting at once truncates piped stdout at 64 KB.
if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { checkReport, parseArgs, main, TOKENS, CONTRACTS, FAMILY_OF };
