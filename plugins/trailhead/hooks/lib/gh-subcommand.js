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

// Parse a raw shell command string and locate the gh subcommand/verb.
// Returns { sub, verb } (verb may be undefined) or null when this is not a
// gh invocation at all.
function parseGhSubcommand(cmd) {
  const toks = String(cmd).trim().split(/\s+/);
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

module.exports = { parseGhSubcommand, BOOLEAN_GLOBAL_FLAGS, WRITE_SUBCOMMANDS };
