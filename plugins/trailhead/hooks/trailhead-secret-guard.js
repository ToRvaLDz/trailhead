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
// earlier in the command); the guard never runs anything.
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
const { splitStatementsWithSeparators, tokenize } = require('./lib/shell-scan.js');

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
  if (sub === 'api' && /(?:^|\s)(?:-f|-F|--field|--raw-field)\s+['"]?body=/.test(stmt)) return 'api';
  return null;
}

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

// --- statement normalisation ---------------------------------------------------

// Quote-aware word splitter. Like shell-scan's tokenize, but a `$(...)`, `<(...)`,
// `>(...)` or backtick span stays inside ONE word even when it holds spaces.
function words(stmt) {
  const s = String(stmt).trim();
  const out = [];
  let cur = '';
  let quote = null; // ' or "
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (quote === '"' && c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
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
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// Reserved words and prefixes that can precede a command inside a compound construct.
const PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', '{', '!', 'time', 'if', 'while', 'until']);
// Wrappers that run the rest of the line as a command (their own flags are skipped).
const WRAPPERS = new Set(['env', 'command', 'builtin', 'nohup', 'exec']);
// Commands that run text we cannot analyse statically.
const OPAQUE_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'xargs']);
// A gh issue/pr write, or a gh api body/--input write, anywhere in some text.
const OPAQUE_WRITE_RE =
  /\bgh\b[\s\S]*?\b(?:issue|pr)\b[\s\S]*?\b(?:create|comment|edit|review)\b|\bgh\b[\s\S]*?\bapi\b[\s\S]*?(?:\bbody=|--input)/;

// Strip what stands between a statement and the command it runs: reserved words
// (do, then, else, !, time, ...), subshell/group openers, and wrapper commands
// (env, command, builtin, nohup, exec). Returns { text, runner } where `runner` is
// true when the command is bash/sh/zsh/eval/xargs (text we cannot analyse).
function unwrap(text) {
  let toks = words(text);
  let opens = 0;
  for (let changed = true; changed && toks.length; ) {
    changed = false;
    const lead = /^\(+/.exec(toks[0]);
    if (lead) {
      opens += lead[0].length;
      toks = [toks[0].slice(lead[0].length), ...toks.slice(1)].filter(Boolean);
      changed = true;
      continue;
    }
    if (PREFIX_WORDS.has(toks[0])) { toks = toks.slice(1); changed = true; continue; }
    let k = 0;
    while (k < toks.length && ASSIGN_TOKEN_RE.test(toks[k])) k++;
    if (k < toks.length && WRAPPERS.has(toks[k])) {
      const w = toks[k];
      let j = k + 1;
      while (j < toks.length) {
        const t = toks[j];
        if (w === 'env' && (t === '-u' || t === '-C')) j += 2;
        else if (t.startsWith('-') || (w === 'env' && ASSIGN_TOKEN_RE.test(t))) j++;
        else break;
      }
      toks = [...toks.slice(0, k), ...toks.slice(j)];
      changed = true;
    }
  }
  if (opens > 0 && toks.length) {
    const last = toks[toks.length - 1];
    const stripped = last.replace(new RegExp(`\\){1,${opens}}$`), '');
    toks = stripped ? [...toks.slice(0, -1), stripped] : toks.slice(0, -1);
  }
  let k = 0;
  while (k < toks.length && ASSIGN_TOKEN_RE.test(toks[k])) k++;
  const cmd0 = toks[k] ? toks[k].replace(/^.*\//, '') : '';
  return { text: toks.join(' '), runner: OPAQUE_RUNNERS.has(cmd0) };
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
    else if (op === '<<<') stdin = { type: 'here' };
    else if (op === '<' || op === '<>') stdin = { type: 'file', word };
    else if (fd === '' || fd === '1' || op.startsWith('&')) outs.push({ word, append: op.endsWith('>>') });
  }
  return { args, outs, stdin };
}

// Values of a gh flag (long form, optional short form), in order: `--long v`,
// `--long=v`, `-s v`, `-s=v` and the attached pflag shorthand `-sv`.
function flagValues(args, long, short) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
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

const ASSIGN_TOKEN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
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
  const writes = [];
  let vars = {};
  let cwdKnown = true;
  let prevSep = null;
  for (const { text: raw, sep } of splitStatementsWithSeparators(cmd)) {
    const subshell = sep === '|' || sep === '&' || prevSep === '|' || prevSep === '&';
    prevSep = sep;
    const { text, runner } = unwrap(raw);
    const kind = writeKind(text);
    if (kind) {
      writes.push({ kind, text, vars, cwdKnown });
      continue;
    }
    // A shell/eval/xargs line, or a command substitution, that holds a gh write
    // cannot be analysed: report it as an opaque write.
    const nested = runner ? (/<<-?/.test(text) ? cmd : text) : /\$\(|`|<\(|>\(/.test(text) ? text : '';
    if (nested && OPAQUE_WRITE_RE.test(nested)) {
      writes.push({ kind: 'opaque', text, vars, cwdKnown });
      continue;
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
        `trailhead: this gh ${kind} write reads its body from a file the secret-guard ${detail}, ` +
        'so it cannot verify the body is secret-free. Write the body to a file and pass its literal absolute path ' +
        '(e.g. `--body-file /tmp/body.md`), with no variables, `~` or command substitution in the path, and post again.',
    },
  };
}

// Pure verdict for one command: allow | block {payload} | advise {payload, stderr}.
// Never exits or writes. `env` carries the test seam so the merged runner's
// environment is the one honoured; `cwd` is the hook input's working directory
// (relative body-file paths resolve against it, process.cwd() when absent).
// Fail closed on a body file: if its path cannot be resolved statically, or the
// resolved file cannot be read, the write is blocked (it would otherwise post an
// unscanned body). Only an internal scanner fault is an advisory.
function evaluate(cmd, { env = process.env, cwd } = {}) {
  const writes = ghWrites(cmd, env);
  if (writes.length === 0) return { kind: 'allow' }; // not a tracker write: out of scope

  const opaque = writes.find((w) => w.kind === 'opaque');
  if (opaque) {
    return {
      kind: 'block',
      payload: {
        decision: 'block',
        code: 'SECRET_GUARD_OPAQUE_WRITE',
        reason:
          'trailhead: a gh issue/PR write runs inside bash -c / sh -c / eval / xargs or a command substitution, ' +
          'so the secret-guard cannot analyse the body it posts. Run the gh command directly, with the body in a file ' +
          'passed by its literal absolute path (--body-file /tmp/body.md), and post again.',
      },
    };
  }

  let text = cmd;
  for (const w of writes) {
    if (w.kind === 'api') continue;
    const ref = resolveBodyFile(w.text, w.vars, env, w.cwdKnown ? cwd : null);
    if (!ref) continue;
    if (ref.unresolved) {
      return bodyFileBlock('SECRET_GUARD_UNRESOLVED_BODY_FILE', w.kind, `cannot resolve statically (${ref.unresolved})`);
    }
    try {
      text += '\n' + fs.readFileSync(ref.path, 'utf8').slice(0, 1_000_000);
    } catch (e) {
      const why = (e && e.code) || 'read error';
      return bodyFileBlock('SECRET_GUARD_UNREADABLE_BODY_FILE', w.kind, `could not read (${why}: ${ref.path})`);
    }
  }

  // From here we KNOW it's a tracker write, so a scan failure must be OBSERVABLE.
  const kind = writes[0].kind;
  try {
    const hit = scan(text, env);
    if (hit) {
      return {
        kind: 'block',
        payload: {
          decision: 'block',
          code: 'SECRET_IN_ISSUE_WRITE',
          reason:
            `trailhead: this ${kind === 'api' ? 'GitHub API write' : `gh ${kind}`} looks like it contains a secret (${hit}). ` +
            'Nothing sensitive may land on the tracker. Redact it: replace the value with `<REDACTED>` or an env-var reference ' +
            '(e.g. `$SUPABASE_KEY`), and post again. If this is a false positive (not a real secret), reword so it no longer matches a credential pattern.',
        },
      };
    }
  } catch (e) {
    return unscannedVerdict(kind, e); // internal fault: fail open, but loudly, never a silent clean-looking pass
  }
  return { kind: 'allow' };
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
