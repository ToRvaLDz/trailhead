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
// Fix: tolerate ONE stray value token after any unknown flag, unless that
// token is itself a flag or a KNOWN_SUBCOMMANDS keyword - so a boolean
// (no-value) flag sitting directly before the subcommand does not swallow it.
// `-R`/`--repo` keep their unconditional two-token handling since that is the
// one value-taking global flag gh actually documents.
//
// Self-contained. No requires.

// Subcommands the guards care about; used to protect a boolean (no-value)
// flag that is immediately followed by the subcommand from being over-consumed.
const KNOWN_SUBCOMMANDS = new Set(['issue', 'pr', 'api']);

// Parse a raw shell command string and locate the gh subcommand/verb.
// Returns { sub, verb } (verb may be undefined) or null when this is not a
// gh invocation at all.
function parseGhSubcommand(cmd) {
  const toks = String(cmd).trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // env prefix
  if (i >= toks.length || !/(^|\/)gh$/.test(toks[i])) return null;         // the gh binary
  i++;
  // Walk global flags before the subcommand. Consume -R/--repo's separate
  // value (the one value-taking global flag gh actually uses). For any OTHER
  // flag, skip the flag token, then tolerate ONE stray value token so an
  // unknown two-token global flag (e.g. `--hostname h`) cannot shift the
  // subcommand position: skip that token unless it is itself a flag or a known
  // subcommand keyword (so a boolean flag sitting directly before the
  // subcommand does not swallow it).
  while (i < toks.length && toks[i].startsWith('-')) {
    const isRepo = /^(-R|--repo)$/.test(toks[i]) && !toks[i].includes('=');
    i++; // the flag itself
    if (isRepo) { i++; continue; } // known two-token flag: consume its value unconditionally
    if (i < toks.length && !toks[i].startsWith('-') && !KNOWN_SUBCOMMANDS.has(toks[i])) i++;
  }
  return { sub: toks[i], verb: toks[i + 1] };
}

module.exports = { parseGhSubcommand, KNOWN_SUBCOMMANDS };
