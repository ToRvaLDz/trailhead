'use strict';
// gh-subcommand.js: shared gh-subcommand detector, extracted from
// trailhead-body-guard.js's ghBodyWrite and trailhead-secret-guard.js's
// ghIssueWrite (#153 follow-up), so both guards share ONE token walk instead
// of drifting copies.
//
// Bug fixed here (#153): the original inline walk only treated `-R`/`--repo`
// as a two-token (value-taking) global gh flag. Any OTHER two-token global
// flag (e.g. `gh --hostname h issue edit 5 --body ""`) desynced the walk:
// after skipping `--hostname`, the index landed on its value `h`, which is
// not a `-`-prefixed flag so the loop stopped there, and `h` was mistaken for
// the subcommand. The write became invisible to both guards (a missed
// empty-body block in body-guard, an unscanned secret in secret-guard).
//
// Follow-up fix (#153): a first pass tolerated a stray value token after any
// unknown flag UNLESS that token was itself a flag or a subcommand keyword
// (issue/pr/api). That guard reintroduced the exact same desync whenever the
// flag's VALUE literally equalled a subcommand keyword, e.g.
// `gh --hostname api issue edit 5` mis-resolved `sub` to `api` (the flag
// value), hiding the real `issue edit` write again.
//
// Fix: drop the keyword-based guard entirely and model flag arity instead.
// gh's only value-taking global flag before a subcommand is -R/--repo; a
// small, explicit set of global flags are boolean (take no value). Every
// OTHER flag token is treated as value-taking, so its value can never be
// mistaken for the subcommand - including when that value happens to equal
// a subcommand keyword like `issue`/`pr`/`api`.
//
// Second follow-up fix (#153): treating every unknown flag as value-taking
// reopened the MIRROR case - an unknown BOOLEAN flag directly before the
// subcommand (e.g. `gh --foo issue edit 5`) now gets treated as value-taking
// and swallows the subcommand itself as if it were the flag's value, landing
// `sub` on the verb (`edit`) instead of `issue`. The two failure directions
// (a flag's VALUE colliding with a subcommand keyword, vs. an unknown
// BOOLEAN flag consuming the subcommand) cannot both be resolved by a
// positional walk alone: `gh --X <tok> issue edit` and `gh --X issue edit`
// are structurally ambiguous without knowing --X's arity in advance, and gh
// itself rejects unknown flags so neither shape occurs with the real `gh`
// binary. But the guard defends against any `gh`-named binary, so it must
// not depend on that.
//
// Design principle: keep the value-taking primary walk (it is correct for
// every KNOWN two-token flag, e.g. -R/--repo, and for the common case of an
// unknown two-token flag), then ADD a fail-safe fallback that scans forward
// for a recognized write-subcommand keyword whenever the walk did not land
// on one. Erring toward DETECTION (scanning/considering a write) is the safe
// direction for a security guard; under-detection (missing a real write) is
// the dangerous one. The downstream verb gate in each guard still prevents a
// stray keyword token in a genuinely non-write command from being
// misclassified as a write.
//
// Third follow-up fix (#219): the walk compared raw, still-quoted tokens, but bash
// removes quotes before `gh` runs, so `"gh" issue comment`, `gh 'issue' comment`,
// `gh issue com""ment`, `\gh ...` or `$'gh' ...` hid the write from both guards.
// Every token is now compared (and `sub`/`verb` returned) in its quote-removed
// form. This slightly over-detects (a quote inside a single-quoted word is
// dropped too), which is the safe direction for a guard.
//
// Self-contained. No requires.

// gh's boolean global flags (take NO value). gh's only value-taking global
// flag before a subcommand is -R/--repo; every other flag token here is
// treated as value-taking, so an unknown two-token global flag's value can
// never be mistaken for the subcommand (#153) - including when that value
// happens to equal a subcommand keyword like `issue`/`pr`/`api`.
const BOOLEAN_GLOBAL_FLAGS = new Set(['-h', '--help', '--version']);

// The subcommands the guards care about; used by the fail-safe fallback
// below to recover from an unknown boolean flag swallowing the subcommand.
const WRITE_SUBCOMMANDS = new Set(['issue', 'pr', 'api']);

// Single-letter ANSI-C escapes (`$'\n'`).
const ANSI_C_SIMPLE = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' };

// Decode the escape at word[i] (the char after a backslash) inside a `$'...'` span:
// { out, next }. Unknown pairs keep the escaped char, so nothing is lost.
function ansiEscape(word, i) {
  const n = word[i];
  if (Object.prototype.hasOwnProperty.call(ANSI_C_SIMPLE, n)) return { out: ANSI_C_SIMPLE[n], next: i + 1 };
  const rest = word.slice(i);
  let m;
  if ((m = /^x([0-9a-fA-F]{1,2})/.exec(rest)) || (m = /^u([0-9a-fA-F]{1,4})/.exec(rest)) || (m = /^U([0-9a-fA-F]{1,8})/.exec(rest))) {
    const cp = parseInt(m[1], 16);
    return { out: cp <= 0x10ffff ? String.fromCodePoint(cp) : m[0], next: i + m[0].length };
  }
  if ((m = /^[0-7]{1,3}/.exec(rest))) return { out: String.fromCharCode(parseInt(m[0], 8) & 0xff), next: i + m[0].length };
  return { out: n, next: i + 1 };
}

// A word as bash passes it once quoting is removed: a `$'...'` span is decoded
// (\xHH, \NNN, \uHHHH, \n ...), `$` before a `"` is dropped, a backslash escape keeps
// the escaped char, `'` and `"` are dropped (#219).
function dequote(word) {
  const w = String(word);
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === '$' && w[i + 1] === "'") {
      i += 2;
      while (i < w.length && w[i] !== "'") {
        if (w[i] === '\\' && i + 1 < w.length) { const e = ansiEscape(w, i + 1); out += e.out; i = e.next; } else out += w[i++];
      }
    } else if (c === '\\' && i + 1 < w.length) out += w[++i];
    else if (c !== "'" && c !== '"' && !(c === '$' && w[i + 1] === '"')) out += c;
  }
  return out;
}

// Parse a raw shell command string and locate the gh subcommand/verb.
// Returns { sub, verb } (verb may be undefined) or null when this is not a
// gh invocation at all.
function parseGhSubcommand(cmd) {
  const toks = String(cmd).trim().split(/\s+/).map(dequote);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // env prefix
  if (i >= toks.length || !/(^|\/)gh$/.test(toks[i])) return null;         // the gh binary
  const start = i + 1; // first token after `gh`
  i = start;
  // Primary positional walk. -R/--repo (and any non-boolean, non-glued flag)
  // is treated as value-taking: consume one following non-flag token so an
  // unknown two-token global flag's value cannot shift the subcommand (#153).
  while (i < toks.length && toks[i].startsWith('-')) {
    const flag = toks[i];
    i++; // the flag token itself
    if (flag.includes('=') || BOOLEAN_GLOBAL_FLAGS.has(flag)) continue; // no separate value
    if (i < toks.length && !toks[i].startsWith('-')) i++;               // consume its value
  }
  let sub = toks[i];
  let verb = toks[i + 1];
  // Fail-safe fallback: if the walk did NOT land on a recognized write
  // subcommand, an unknown *boolean* flag before the subcommand may have
  // consumed the subcommand itself as if it were the flag's value (the mirror
  // of the value-collision case). Scan forward for the first recognized
  // subcommand keyword and use it. Over-detection is the safe direction for a
  // guard; under-detection (missing a real write) is the dangerous one (#153).
  // The downstream guards still gate on the verb, so a stray keyword token in a
  // non-write command does not become a spurious write.
  if (!WRITE_SUBCOMMANDS.has(sub)) {
    for (let j = start; j < toks.length; j++) {
      if (WRITE_SUBCOMMANDS.has(toks[j])) { sub = toks[j]; verb = toks[j + 1]; break; }
    }
  }
  return { sub, verb };
}

module.exports = { parseGhSubcommand, dequote, BOOLEAN_GLOBAL_FLAGS, WRITE_SUBCOMMANDS };
