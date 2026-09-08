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
// Self-contained. No requires.

// gh's boolean global flags (take NO value). gh's only value-taking global
// flag before a subcommand is -R/--repo; every other flag token here is
// treated as value-taking, so an unknown two-token global flag's value can
// never be mistaken for the subcommand (#153) - including when that value
// happens to equal a subcommand keyword like `issue`/`pr`/`api`.
const BOOLEAN_GLOBAL_FLAGS = new Set(['-h', '--help', '--version']);

// Parse a raw shell command string and locate the gh subcommand/verb.
// Returns { sub, verb } (verb may be undefined) or null when this is not a
// gh invocation at all.
function parseGhSubcommand(cmd) {
  const toks = String(cmd).trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // env prefix
  if (i >= toks.length || !/(^|\/)gh$/.test(toks[i])) return null;         // the gh binary
  i++;
  // Walk global flags before the subcommand.
  while (i < toks.length && toks[i].startsWith('-')) {
    const flag = toks[i];
    i++; // consume the flag token itself
    // A glued --flag=value / -x=value carries its value in the same token; a
    // boolean global flag takes no value. Any other flag is value-taking:
    // consume one following non-flag token so its value cannot shift the
    // subcommand position.
    if (flag.includes('=') || BOOLEAN_GLOBAL_FLAGS.has(flag)) continue;
    if (i < toks.length && !toks[i].startsWith('-')) i++;
  }
  return { sub: toks[i], verb: toks[i + 1] };
}

module.exports = { parseGhSubcommand, BOOLEAN_GLOBAL_FLAGS };
