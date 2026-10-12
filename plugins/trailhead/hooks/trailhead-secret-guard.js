#!/usr/bin/env node
// trailhead-secret-guard.js: PreToolUse(Bash) hook.
// trailhead posts a lot to GitHub Issues/PRs (ticket bodies, engine comments,
// codebase/conventions issues, resolutions) while working on codebases that hold
// secrets. This is the outbound barrier: it scans what a `gh` write is about to
// post to an issue/PR/comment and BLOCKS if it looks like a secret is in it, so
// nothing sensitive lands on the tracker.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Every gh write in a compound command is checked (`D=/x && gh issue comment ...`,
// `cd d && gh pr comment ...`), not just a command that starts with gh. A
// --body-file path is resolved statically ($NAME, ${NAME}, leading ~, variables set
// earlier in the command); the guard never runs anything. Bodies read from stdin
// (< file, cat file | gh), $(cat file), $VAR, gh api body=@file / --input are
// resolved and scanned too, and a body file the same command writes first (heredoc
// redirect, tee, cat, cp) is traced to its source. Expansions inside inline content
// (echo/printf arguments, unquoted heredocs, herestrings, --body) are resolved and
// scanned. Writes inside $(...) or backticks, function bodies, case arms and behind
// wrappers (env, sudo, nice, timeout, ...) or a variable command word are analysed
// like any other write.
// Known limits, accepted (fail closed or best-effort, never silent):
//   - a gh write run through bash -c / sh -c / zsh -c / eval / xargs is not analysed:
//     it blocks as SECRET_GUARD_OPAQUE_WRITE (run gh directly instead);
//   - a body file produced by an unrecognised writer (curl -o, a script, ...) in the
//     same command is not traced: the file must already exist, or the write blocks.
// Fail-CLOSED on a body file it cannot vouch for: a path that cannot be resolved
// statically (unknown variable, $(...), backticks, a relative path after a cd)
// blocks with SECRET_GUARD_UNRESOLVED_BODY_FILE, and a resolved file that cannot
// be read blocks with SECRET_GUARD_UNREADABLE_BODY_FILE. Otherwise the write would
// post an unscanned body.
// Fail-OPEN only on an internal scanner fault, to keep the workflow moving, but the
// failure is made OBSERVABLE (an advisory), never byte-identical to a clean pass:
// once a write is identified, a scan error emits a "could-not-scan" advisory
// instead of silently allowing. (Anti-pattern: a guard whose failure looks exactly
// like a success.)
// Self-contained. Pure functions (incl. evaluate) are exported for tests and for
// the merged trailhead-bash-guards.js; runs as a hook when executed directly.

const fs = require('fs');
const path = require('path');
const { parseGhSubcommand } = require('./lib/gh-subcommand.js');
const { splitStatementsWithSeparators, heredocBodies, countHeredocs, tokenize, stripQuotes } = require('./lib/shell-scan.js');
const {
  ASSIGN_TOKEN_RE,
  STDIN_PATHS,
  words,
  expandWord,
  parseRedirects,
  flagValues,
  resolveWord,
  substitutionSpans,
  joinedText,
  resolvedWords,
  bodySources,
  readBodyFile,
} = require('./lib/body-sources.js');

// High-confidence secret formats: a match here is almost never a false positive.
const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'OpenAI/Anthropic key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe live key', re: /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'JWT / Supabase key', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
];

// Assignment heuristic: a secret-named key set to a real-looking value.
const ASSIGN_RE =
  /\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|bearer|dsn|conn(?:ection)?[_-]?string)\b\s*[:=]\s*["']?([^\s"']{8,})/i;
// Values that are clearly NOT a real secret (placeholders, env refs, redactions).
const SAFE_VALUE =
  /^(?:\$|\$\{|<|\*{2,}|x{3,}|redacted|your[-_]|example|placeholder|dummy|test|todo|none|null|true|false|process\.env|import\.meta|os\.environ)/i;

// Kind of tracker write ('issue' | 'pr' | 'api') one statement performs, or null.
function writeKind(stmt) {
  const parsed = parseGhSubcommand(stmt);
  if (!parsed) return null;
  const { sub, verb } = parsed;
  if ((sub === 'issue' || sub === 'pr') && ['create', 'comment', 'edit', 'review'].includes(verb)) {
    return sub;
  }
  if (sub === 'api' && /(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s+|=)?['"]?body=/.test(stmt)) return 'api';
  if (sub === 'api' && /(?:^|\s)--input(?:=|\s|$)/.test(stmt)) return 'api'; // --input sends a request body from a file
  return null;
}

// --- statement normalisation ---------------------------------------------------

// Reserved words and prefixes that can precede a command inside a compound construct.
const PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', '{', '!', 'time', 'if', 'while', 'until']);
// Wrappers that run the rest of the line as a command, with the flags of each that
// take a separate value (skipped together with it).
const WRAPPER_VALUE_FLAGS = {
  env: ['-u', '-C', '-S'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  timeout: ['-k', '-s'],
  stdbuf: ['-i', '-o', '-e'],
  exec: ['-a'],
  command: [],
  builtin: [],
  nohup: [],
};
// Commands that run text we cannot analyse statically.
const WRAPPERS = new Set(Object.keys(WRAPPER_VALUE_FLAGS));
const OPAQUE_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'xargs']);
// A gh write's words after a command word we could not resolve (`$CMD issue comment ...`).
const WRITE_WORDS_RE = /\b(?:issue|pr)\b[\s\S]*?\b(?:create|comment|edit|review)\b|\bapi\b[\s\S]*?(?:\bbody=|--input)/;

// Index just past a wrapper command's own flags (and values), starting at the
// wrapper token toks[k]. `timeout` also takes a DURATION positional.
function skipWrapperArgs(toks, k) {
  const w = toks[k];
  const valueFlags = WRAPPER_VALUE_FLAGS[w];
  let j = k + 1;
  while (j < toks.length) {
    const t = toks[j];
    if (valueFlags.includes(t)) j += 2;
    else if (t.startsWith('-')) j++;
    else if ((w === 'env' || w === 'sudo') && ASSIGN_TOKEN_RE.test(t)) j++;
    else break;
  }
  if (w === 'timeout' && j < toks.length) j++;
  return j;
}

// One leading construct stripped from `toks`, or null: a subshell opener, a reserved
// word, a function definition head, a case head or arm pattern, or a wrapper command.
function stripLeader(toks) {
  const t0 = toks[0];
  const lead = /^\(+/.exec(t0);
  if (lead) return { toks: [t0.slice(lead[0].length), ...toks.slice(1)].filter(Boolean), opens: lead[0].length };
  if (PREFIX_WORDS.has(t0)) return { toks: toks.slice(1) };
  if (t0 === 'function') return { toks: toks.slice(toks[2] === '()' ? 3 : 2) }; // function NAME [()]
  if (/^[A-Za-z_][\w.:-]*\(\)\{?$/.test(t0)) return { toks: toks.slice(1) }; // name() / name(){
  if (/^[A-Za-z_][\w.:-]*$/.test(t0) && toks[1] === '()') return { toks: toks.slice(2) }; // name ()
  if (t0 === 'case' && toks.includes('in')) return { toks: toks.slice(toks.indexOf('in') + 1) };
  if (/^[^\s()$"'`]*\)$/.test(t0)) return { toks: toks.slice(1) }; // case arm pattern)
  let k = 0;
  while (k < toks.length && ASSIGN_TOKEN_RE.test(toks[k])) k++;
  if (k < toks.length && WRAPPERS.has(toks[k])) {
    return { toks: [...toks.slice(0, k), ...toks.slice(skipWrapperArgs(toks, k))] };
  }
  return null;
}

// xargs flags that take a separate value (a long flag only when written without `=`).
const XARGS_VALUE_FLAGS = new Set([
  '-I', '-n', '-P', '-d', '-E', '-L', '-s', '-a', '-R', '-S', '-J',
  '--arg-file', '--delimiter', '--eof', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var',
]);
// xargs long flags that take no separate value (`--replace` and `--eof` also accept `=`).
const XARGS_BOOLEAN_LONG = new Set([
  '--null', '--no-run-if-empty', '--verbose', '--interactive', '--open-tty', '--exit', '--show-limits',
  '--version', '--help', '--replace', '--',
]);

// The script text a shell/eval/xargs statement runs, as a list of strings to analyse
// (the `-c` string, eval's arguments, the heredoc bodies fed to a shell, the command
// xargs runs). Only the runner's own arguments: never the rest of the command.
function runnerScripts(text, heredocs) {
  const { args } = parseRedirects(words(text));
  let k = 0;
  while (k < args.length && ASSIGN_TOKEN_RE.test(args[k])) k++;
  const name = args[k].replace(/^.*\//, '');
  const rest = args.slice(k + 1);
  if (name === 'eval') return [rest.map(stripQuotes).join(' ')];
  if (name === 'xargs') {
    let j = 0;
    let unknownLong = false; // a long flag we cannot size: its value might be taken for the command
    while (j < rest.length && rest[j].startsWith('-')) {
      const f = rest[j];
      if (f.startsWith('--') && !f.includes('=') && !XARGS_VALUE_FLAGS.has(f) && !XARGS_BOOLEAN_LONG.has(f)) unknownLong = true;
      j += XARGS_VALUE_FLAGS.has(f) ? 2 : 1;
    }
    if (j >= rest.length) return [];
    // The command runs directly: quotes stay for the recursion. After an unknown flag
    // fail closed: also try each later word as the command.
    const from = unknownLong ? rest.map((_, i) => i).filter((i) => i >= j) : [j];
    return from.map((i) => rest.slice(i).join(' '));
  }
  const c = rest.findIndex((a) => /^-[A-Za-z]*c$/.test(a));
  if (c >= 0) return rest[c + 1] === undefined ? [] : [stripQuotes(rest[c + 1])];
  return heredocs.map((h) => h.body); // a script fed on stdin
}

// Strip what stands between a statement and the command it runs: reserved words
// (do, then, else, !, time, ...), subshell/group openers, function and case heads,
// and wrapper commands (env, sudo, nice, timeout, ...). A variable command word
// (`$G issue ...`) is resolved with the variables known so far. Returns
//   { text, runner, unresolvedCmd }
// `runner` is true for bash/sh/zsh/eval/xargs (text we cannot analyse) and
// `unresolvedCmd` for a command word that is a variable we cannot resolve.
function unwrap(text, vars = {}, env = {}) {
  let toks = words(text);
  let opens = 0;
  for (let step = toks.length ? stripLeader(toks) : null; step; step = toks.length ? stripLeader(toks) : null) {
    toks = step.toks;
    opens += step.opens || 0;
  }
  if (opens > 0 && toks.length) {
    const last = toks[toks.length - 1];
    const stripped = last.replace(new RegExp(`\\){1,${opens}}$`), '');
    toks = stripped ? [...toks.slice(0, -1), stripped] : toks.slice(0, -1);
  }
  let k = 0;
  while (k < toks.length && ASSIGN_TOKEN_RE.test(toks[k])) k++;
  let unresolvedCmd = false;
  if (toks[k] && /^"?\$\{?[A-Za-z_]/.test(toks[k])) {
    const r = expandWord(toks[k], vars, env);
    if (r.unresolved) unresolvedCmd = true;
    else toks = [...toks.slice(0, k), r.value, ...toks.slice(k + 1)];
  }
  const cmd0 = toks[k] ? toks[k].replace(/^.*\//, '') : '';
  return { text: toks.join(' '), runner: OPAQUE_RUNNERS.has(cmd0), unresolvedCmd };
}

// The --body-file path of one gh statement, resolved WITHOUT running anything.
//   { path }       an absolute path to read
//   { unresolved } the path cannot be known statically (reason given): fail closed
//   null           no --body-file/-F, or it reads stdin
// `vars` are the variables set earlier in the command (name -> string, or null when
// unresolvable), `env` the hook's environment. A relative path resolves against
// `cwd` (process.cwd() when undefined); cwd === null means the working directory is
// no longer known (an earlier cd), so a relative path is unresolved. The last
// --body-file/-F wins, as in gh.
function resolveBodyFile(stmt, vars, env, cwd) {
  const { args } = parseRedirects(words(stmt));
  const vals = flagValues(args, '--body-file', '-F');
  if (vals.length === 0) return null;
  const raw = vals[vals.length - 1];
  if (STDIN_PATHS.has(raw)) return null; // stdin: its content is the command string or a producer
  return resolveWord(raw, vars, env, cwd);
}

// --- variable tracking across a compound command -------------------------------

const DECL_KEYWORDS = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);

// [[name, rawValue], ...] when the statement is only assignments (optionally behind
// export/declare/...), else null. `D=v cmd ...` (an inline prefix) is not one.
function parseAssignments(text) {
  const toks = tokenize(text);
  const decl = DECL_KEYWORDS.has(toks[0]);
  const out = [];
  for (let i = decl ? 1 : 0; i < toks.length; i++) {
    const m = ASSIGN_TOKEN_RE.exec(toks[i]);
    if (m) out.push([m[1], m[2]]);
    else if (!(decl && (toks[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*$/.test(toks[i])))) return null;
  }
  return decl || out.length ? out : null;
}

function changesDir(text) {
  const toks = tokenize(text);
  let i = 0;
  while (i < toks.length && ASSIGN_TOKEN_RE.test(toks[i])) i++;
  return ['cd', 'pushd', 'popd'].includes(toks[i]);
}

// Every `gh` tracker write in a (possibly compound) command, in order:
// { kind, text, vars, cwdKnown }. The command is split into statements (`;`, `&&`,
// `||`, `|`, `&`, newline) and each is checked on its own: `D=/x && gh issue comment
// ...` or `cd d && gh pr comment ...` is a write even though the string does not
// START with gh. `vars` are the variables the write can see: a pure `NAME=v`
// statement propagates, except in a pipeline or a backgrounded statement (a
// subshell); an inline `NAME=v gh ...` prefix is the child's environment only.
// `cwdKnown` turns false after a cd/pushd/popd.
function ghWrites(cmd, env = process.env) {
  return collectWrites(cmd, env, { vars: {}, cwdKnown: true });
}

// ghWrites from a given starting state (a command substitution starts with the
// variables and working directory of the statement that holds it).
function collectWrites(cmd, env, start) {
  const writes = [];
  const history = []; // every statement: { text, sep, vars, cwdKnown, index, heredocs }
  const bodies = heredocBodies(cmd);
  let nextBody = 0;
  let vars = start.vars;
  let cwdKnown = start.cwdKnown;
  let prevSep = null;
  for (const entry of splitStatementsWithSeparators(cmd)) {
    const { text: raw, sep } = entry;
    const subshell = sep === '|' || sep === '&' || prevSep === '|' || prevSep === '&';
    prevSep = sep;
    const { text, runner, unresolvedCmd } = unwrap(raw, vars, env);
    const index = history.length;
    const heredocs = bodies.slice(nextBody, nextBody + countHeredocs(entry));
    nextBody += heredocs.length;
    history.push({ text, sep, vars, cwdKnown, index, heredocs });
    const kind = writeKind(text);
    if (kind) {
      writes.push({ kind, text, vars, cwdKnown, index, history });
      continue;
    }
    if (unresolvedCmd && WRITE_WORDS_RE.test(text)) {
      writes.push({ kind: 'opaque', text, vars, cwdKnown, index, history });
      continue;
    }
    // A shell/eval/xargs line that holds a gh write cannot be analysed (opaque). A
    // command substitution is analysed like any other command, from this state.
    if (runner) {
      const state = { vars, cwdKnown };
      if (runnerScripts(text, heredocs).some((script) => collectWrites(script, env, state).length > 0)) {
        writes.push({ kind: 'opaque', text, vars, cwdKnown, index, history });
        continue;
      }
    } else {
      for (const sp of substitutionSpans(text)) writes.push(...collectWrites(sp.inner, env, { vars, cwdKnown }));
    }
    const assigns = parseAssignments(text);
    if (assigns) {
      if (!subshell) {
        const next = { ...vars };
        for (const [name, rawValue] of assigns) {
          const r = expandWord(rawValue, next, env);
          next[name] = r.unresolved ? null : r.value;
        }
        vars = next;
      }
      continue;
    }
    if (changesDir(text)) cwdKnown = false;
  }
  return writes;
}

// Is this command a `gh` write of issue/PR/comment text? Returns the kind of the
// first write, or null.
function ghIssueWrite(cmd, env = process.env) {
  const first = ghWrites(cmd, env)[0];
  return first ? first.kind : null;
}

// The text of the --body-file a gh issue/pr write in `cmd` reads ('' when none).
// A thin wrapper over the resolver: it throws when the path cannot be resolved
// statically or read, rather than guessing. Kept for callers and tests; evaluate()
// does its own, fuller, body-source analysis.
function bodyFileText(cmd, env = process.env, cwd) {
  const w = ghWrites(cmd, env).find((x) => x.kind === 'issue' || x.kind === 'pr');
  if (!w) return '';
  const ref = resolveBodyFile(w.text, w.vars, env, w.cwdKnown ? cwd : null);
  if (!ref) return '';
  if (ref.unresolved) throw new Error(`body file path not resolvable (${ref.unresolved})`);
  return fs.readFileSync(ref.path, 'utf8').slice(0, 1_000_000);
}

function scan(text, env = process.env) {
  if (env.TRAILHEAD_SECRETGUARD_THROW === '1') throw new Error('forced fault (test seam)');
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  const a = text.match(ASSIGN_RE);
  if (a && !SAFE_VALUE.test(a[2])) return `hardcoded ${a[1].toLowerCase()}`;
  return null;
}

// A scan we could NOT complete on a write we DID identify: surface it, don't hide it.
function unscannedVerdict(kind, err) {
  const detail = String((err && err.message) || err || 'unknown').slice(0, 120);
  return {
    kind: 'advise',
    stderr: `trailhead secret-guard: could not scan this ${kind} write (${detail}): NOT verified secret-free\n`,
    payload: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `⚠️ trailhead secret-guard could NOT complete its scan of this ${kind} write (${detail}). ` +
          'It did NOT verify the content is secret-free. Check the body by hand before it lands, or re-run. ' +
          'Do not treat this as a clean pass.',
      },
    },
  };
}

// A block verdict for a body file the guard cannot vouch for.
function bodyFileBlock(code, kind, detail) {
  return {
    kind: 'block',
    payload: {
      decision: 'block',
      code,
      reason:
        `trailhead: this gh ${kind} write reads its body from a source the secret-guard ${detail}, ` +
        'so it cannot verify the body is secret-free. Write the body file in a separate Bash call first ' +
        "(or with a heredoc redirect in the same command: `cat > /tmp/body.md <<'EOF' ... EOF`), " +
        'then pass its literal absolute path (`--body-file /tmp/body.md`). Paths built with `$(mktemp)` ' +
        'or any other command substitution cannot be resolved.',
    },
  };
}

// A block verdict for inline body text (--body, echo, heredoc) with an expansion the
// guard cannot resolve.
function inlineBodyBlock(kind, detail) {
  return blockVerdict(
    'SECRET_GUARD_UNRESOLVED_BODY_FILE',
    `trailhead: this gh ${kind} write has body text the secret-guard ${detail}, so it cannot verify the body is ` +
      "secret-free. To post literal text, put it in single quotes ('...') so the shell does not expand it, " +
      'or write it to a file and pass its literal absolute path (`--body-file /tmp/body.md`).',
  );
}

function blockVerdict(code, reason) {
  return { kind: 'block', payload: { decision: 'block', code, reason } };
}

function opaqueBlock() {
  return blockVerdict(
    'SECRET_GUARD_OPAQUE_WRITE',
    'trailhead: a gh issue/PR write runs inside bash -c / sh -c / eval / xargs, so the secret-guard cannot analyse ' +
      'the body it posts. Run the gh command directly, with the body in a file passed by its literal absolute path ' +
      '(--body-file /tmp/body.md), and post again.',
  );
}

function secretBlock(kind, hit) {
  return blockVerdict(
    'SECRET_IN_ISSUE_WRITE',
    `trailhead: this ${kind === 'api' ? 'GitHub API write' : `gh ${kind}`} looks like it contains a secret (${hit}). ` +
      'Nothing sensitive may land on the tracker. Redact it: replace the value with `<REDACTED>` or an env-var reference ' +
      '(e.g. `$SUPABASE_KEY`), and post again. If this is a false positive (not a real secret), reword so it no longer matches a credential pattern.',
  );
}

// The text to scan for a set of writes: the command itself plus every body source
// (expanded values, files read). Returns { text } or { block } when a source cannot
// be resolved or read (fail closed).
function gatherText(cmd, writes, env, cwd) {
  let text = cmd;
  // The raw command keeps a token broken by a backslash-newline; scan it joined as well.
  const histories = new Set(writes.map((w) => w.history));
  if (cmd.includes('\\\n')) {
    for (const history of histories) {
      for (const part of joinedText(history)) text += '\n' + part;
    }
  }
  // Adjacent quoted parts (`"a""b"`) are one word for bash; scan the quote-resolved words (#217).
  for (const history of histories) {
    for (const word of resolvedWords(history)) text += '\n' + word;
  }
  for (const w of writes) {
    for (const item of bodySources(w, { env, cwd, history: w.history })) {
      if (item.unresolved) {
        const detail = `cannot resolve statically (${item.unresolved})`;
        return { block: item.inline ? inlineBodyBlock(w.kind, detail) : bodyFileBlock('SECRET_GUARD_UNRESOLVED_BODY_FILE', w.kind, detail) };
      }
      if (item.text !== undefined) { text += '\n' + item.text; continue; }
      try {
        text += '\n' + readBodyFile(item.path, item.optional);
      } catch (e) {
        const why = (e && e.code) || 'read error';
        return { block: bodyFileBlock('SECRET_GUARD_UNREADABLE_BODY_FILE', w.kind, `could not read (${why}: ${item.path})`) };
      }
    }
  }
  return { text };
}

// Pure verdict for one command: allow | block {payload} | advise {payload, stderr}.
// Never exits or writes. `env` carries the test seam so the merged runner's
// environment is the one honoured; `cwd` is the hook input's working directory
// (relative body-file paths resolve against it, process.cwd() when absent).
// Fail closed on a body source: if its path cannot be resolved statically, or the
// resolved file cannot be read, the write is blocked (it would otherwise post an
// unscanned body). Only an internal scanner fault is an advisory.
function evaluate(cmd, { env = process.env, cwd } = {}) {
  const writes = ghWrites(cmd, env);
  if (writes.length === 0) return { kind: 'allow' }; // not a tracker write: out of scope
  if (writes.some((w) => w.kind === 'opaque')) return opaqueBlock();

  const gathered = gatherText(cmd, writes, env, cwd);
  if (gathered.block) return gathered.block;

  // From here we KNOW it's a tracker write, so a scan failure must be OBSERVABLE.
  const kind = writes[0].kind;
  try {
    const hit = scan(gathered.text, env);
    return hit ? secretBlock(kind, hit) : { kind: 'allow' };
  } catch (e) {
    return unscannedVerdict(kind, e); // internal fault: fail open, but loudly, never a silent clean-looking pass
  }
}

function run(data) {
  let cmd = '';
  let cwd;
  try {
    const input = JSON.parse(data);
    cmd = (input.tool_input || {}).command || '';
    cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined;
  } catch {
    process.exit(0); // unparseable input: nothing meaningful to say
  }
  const v = evaluate(cmd, { cwd });
  if (v.kind === 'block') {
    process.stdout.write(JSON.stringify(v.payload));
    process.exit(2);
  }
  if (v.kind === 'advise') {
    process.stderr.write(v.stderr);
    process.stdout.write(JSON.stringify(v.payload));
  }
  process.exit(0);
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

module.exports = { ghIssueWrite, ghWrites, resolveBodyFile, bodyFileText, scan, evaluate, SECRET_PATTERNS };
