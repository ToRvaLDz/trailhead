#!/usr/bin/env node
// trailhead-body-guard.js: PreToolUse(Bash) hook.
// trailhead rewrites issue/PR bodies with a read-modify-write: `gh issue view
// <n> --json body` -> transform in memory -> `gh issue edit <n> --body...`.
// If the pre-write read hits a transient failure (e.g. a GitHub HTTP 5xx) and
// comes back with an empty body without `gh` exiting non-zero, that empty
// string flows straight into the write and clobbers the existing body. A
// trailhead body is never legitimately empty, so this is the write-site
// backstop: it hard-blocks a `gh issue edit` / `gh pr edit` / `gh api` write
// that would set a body to empty or whitespace-only, protecting the existing
// body from a degraded read.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Fail-OPEN on any error (exit 0): this is a cheap backstop, not a hard
// dependency, and a crash here must never block a legitimate write.
// Self-contained. Pure functions are exported for tests; runs as a hook when
// executed directly.

const fs = require('fs');
const os = require('os');
const { parseGhSubcommand } = require('./lib/gh-subcommand.js');

// Is the resolved body text clearly empty or whitespace-only?
function isEmptyBody(text) {
  return text === '' || /^\s*$/.test(text);
}

// A value that is a shell expansion (command substitution, backticks, or a
// bare env-var reference) can't be resolved statically: treat it as unknown
// rather than guessing, so the guard never blocks on a body it can't prove
// empty.
function isShellExpansion(text) {
  return /\$\(/.test(text) || /`/.test(text) || /^\$/.test(text);
}

// `fs.readFileSync` does not expand `~`; do it ourselves so a `~/`-prefixed
// (or bare `~`) --body-file / api @-path is actually read, rather than
// throwing ENOENT and silently falling through to "unknowable".
function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return os.homedir() + p.slice(1);
  return p;
}

// Read a --body-file (or api `@file`) target, mirroring secret-guard's
// bodyFileText: sliced to ~1MB. Throws (ENOENT etc.) are the caller's
// problem to catch.
function readBodyFile(filePath) {
  return fs.readFileSync(expandHome(filePath), 'utf8').slice(0, 1_000_000);
}

// Strip one matching pair of surrounding quotes (an artifact of parsing a
// bare `body=` value that itself contains a literal `""`/`''`, e.g. `-f
// body=""`, where the RAW command text carries the quote characters rather
// than the shell having already stripped them). A no-op when the value
// isn't quote-wrapped.
function stripQuotedPair(val) {
  if (val.length >= 2) {
    const first = val[0];
    const last = val[val.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return val.slice(1, -1);
    }
  }
  return val;
}

// Resolve the body for a `gh issue edit` / `gh pr edit` command. Returns:
//   undefined -> no body param present at all (not a body-carrying write)
//   { body: string } -> known body text
//   { body: null }   -> a body param IS present but its text is unknowable
//                        (shell expansion, stdin/process-substitution path,
//                        or an unreadable --body-file): never block on this.
function resolveEditBody(cmd) {
  // --body-file <path> / its short alias -F (quoted or bare; bare stops at
  // whitespace/shell metacharacters, same tokenizer approach as
  // secret-guard's bodyFileText). The `(?<![-\w])` guard on -F mirrors
  // secret-guard's bodyFileText: it stops -F matching when embedded inside
  // a longer token, and keeps --body-file from being double-matched.
  const fileMatch = cmd.match(
    /(?:--body-file|(?<![-\w])-F)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"';|&()<>`]+))/
  );
  if (fileMatch) {
    const p = fileMatch[1] || fileMatch[2] || fileMatch[3];
    if (p === '-' || p.startsWith('<')) return { body: null }; // stdin / process substitution
    try {
      return { body: readBodyFile(p) };
    } catch {
      return { body: null }; // unreadable: unknowable, not provably empty
    }
  }

  // Inline --body <val> / --body=<val> / its short alias -b, quoted or
  // bare. The `(?<![-\w])` guard on -b keeps it from matching the "-b"
  // that appears inside "--body" itself.
  const inlineMatch = cmd.match(
    /(?:--body|(?<![-\w])-b)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S*))/
  );
  if (inlineMatch) {
    const val =
      inlineMatch[1] !== undefined
        ? inlineMatch[1]
        : inlineMatch[2] !== undefined
        ? inlineMatch[2]
        : inlineMatch[3];
    if (val === undefined) return { body: null };
    if (isShellExpansion(val)) return { body: null };
    return { body: val };
  }

  return undefined; // no body param at all
}

// Resolve the body for a `gh api ... -f/-F/--field/--raw-field body=<val>`
// write. Called only once the caller has already confirmed a `body=` field
// is present, so a null return here always means "unknowable", never
// "absent". Handles gh's `@<path>` file-reference form (`@-` is stdin, so
// unknowable) and a bare value carrying literal surrounding quotes (e.g.
// `-f body=""`, where the shell hasn't run yet so the quote characters are
// still in the raw command text).
function resolveApiBody(cmd) {
  let raw;
  let m = cmd.match(/(?:-f|-F|--field|--raw-field)\s+"body=([^"]*)"/);
  if (m) raw = m[1];
  if (raw === undefined) {
    m = cmd.match(/(?:-f|-F|--field|--raw-field)\s+'body=([^']*)'/);
    if (m) raw = m[1];
  }
  if (raw === undefined) {
    m = cmd.match(/(?:-f|-F|--field|--raw-field)\s+body=(\S*)/);
    if (m) raw = m[1];
  }
  if (raw === undefined) return null;

  const val = stripQuotedPair(raw);

  if (val.startsWith('@')) {
    const ref = val.slice(1);
    if (ref === '-') return null; // @- : stdin, unknowable
    try {
      return readBodyFile(ref);
    } catch {
      return null; // unreadable: unknowable, not provably empty
    }
  }

  if (isShellExpansion(val)) return null;
  return val;
}

// Is this a `gh` write that would CLOBBER an issue/PR body (the
// read-modify-write overwrite shape), and if so what would it write?
// Returns { kind, body } or null. `kind` is 'issue' | 'pr' | 'api'; `body` is
// the resolved text (string), or null when present-but-unknowable. Only
// `gh issue edit` / `gh pr edit` / `gh api ... body=` are recognised: `create`
// and `comment` add new content rather than overwrite an existing body, so
// they are out of scope for this guard.
function ghBodyWrite(cmd) {
  const parsed = parseGhSubcommand(cmd);
  if (!parsed) return null;
  const { sub, verb } = parsed;

  if ((sub === 'issue' || sub === 'pr') && verb === 'edit') {
    const resolved = resolveEditBody(cmd);
    if (resolved === undefined) return null; // no body param: not this guard's concern
    return { kind: sub, body: resolved.body };
  }
  if (sub === 'api' && /(?:^|\s)(?:-f|-F|--field|--raw-field)\s+['"]?body=/.test(cmd)) {
    return { kind: 'api', body: resolveApiBody(cmd) };
  }
  return null;
}

function block(kind) {
  const label = kind === 'api' ? 'GitHub API write' : `gh ${kind} edit`;
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      code: 'EMPTY_ISSUE_BODY_WRITE',
      reason:
        `trailhead: this ${label} would set an EMPTY issue body, overwriting the existing one. ` +
        'A trailhead body is never legitimately empty, so this usually means a read-modify-write whose ' +
        'pre-write read returned an empty or degraded body (e.g. a transient HTTP 5xx on `gh issue view --json body`). ' +
        'Aborting to protect the existing body: re-read the current body (treat a non-200 or empty read as a hard ' +
        'error, retry once with backoff), rebuild it, then write again.',
    })
  );
  process.exit(2);
}

function run(data) {
  try {
    let cmd = '';
    try {
      cmd = (JSON.parse(data).tool_input || {}).command || '';
    } catch {
      process.exit(0); // unparseable input: nothing meaningful to say
    }
    const hit = ghBodyWrite(cmd);
    if (!hit || hit.body === null || hit.body === undefined) {
      process.exit(0); // not a body write, or a body we cannot prove empty
    }
    if (isEmptyBody(hit.body)) {
      block(hit.kind);
    }
    process.exit(0);
  } catch {
    process.exit(0); // never let a crash here block a legitimate write
  }
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends → give up (no write identified)
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { ghBodyWrite, isEmptyBody, resolveEditBody, resolveApiBody };
