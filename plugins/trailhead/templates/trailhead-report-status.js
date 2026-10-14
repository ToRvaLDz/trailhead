#!/usr/bin/env node
'use strict';
// trailhead report status check (self-contained, ships in templates/ so it reaches
// every install channel). Checks the leading `status:` line of a Code review or
// Goal-backward verification report before the engine branches on it. #250.
//
// CLI:
//   node trailhead-report-status.js --technique <verify|code-review> [--file <path>]
// Reads the report from --file, or from stdin when there is none. Prints exactly
// one JSON line {"action","verdict","problem","report"}:
//   action   accept | normalise | reask
//   verdict  the canonical token, or null on reask
//   problem  null | missing | unknown-token | conflicting | counts (null iff not reask)
//   report   the original text on accept and reask; the normalised text on normalise
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
// Problem precedence on mixed defects: missing > conflicting > unknown-token > counts.

const fs = require('fs');

// Hard-coded here; report-status.test.js asserts these equal the tokens parsed
// from skills/_shared/techniques/{verify,code-review}.md, which stay the source.
const TOKENS = Object.freeze({
  verify: Object.freeze(['met', 'gaps_found', 'inconclusive']),
  'code-review': Object.freeze(['clean', 'issues_found']),
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

const reask = (text, problem) => ({ action: 'reask', verdict: null, problem, report: text });

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

  const exact = cleanLayout && statusLines.length === 1 && statusLines[0].i === 0 && lines[0] === `status: ${verdict}`
    && (counts.length === 0 || (counts[0].i === 1 && lines[1] === counts[0].text));
  if (exact) return { action: 'accept', verdict, problem: null, report: original };

  // Blank lines that led the original are not content: drop them with the status lines.
  const lead = lines.findIndex((l) => l.trim() !== '');
  const drop = new Set([...statusLines, ...counts].map((c) => c.i));
  const rest = lines.filter((_, i) => !drop.has(i) && i >= lead);
  const head = [`status: ${verdict}`, ...counts.map((c) => c.text)];
  return { action: 'normalise', verdict, problem: null, report: [...head, ...rest].join('\n') };
}

function parseArgs(argv) {
  const opts = { technique: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--technique' || a === '--file') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a === '--technique' ? 'technique' : 'file'] = v;
      i++;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.technique) throw new Error('--technique <verify|code-review> is required');
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
    const text = opts.file ? readFile(opts.file) : readStdin();
    result = checkReport(text, opts.technique);
  } catch (e) {
    stderr.write(`${JSON.stringify({ error: e.message })}\n`);
    return 2;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { checkReport, parseArgs, main, TOKENS };
