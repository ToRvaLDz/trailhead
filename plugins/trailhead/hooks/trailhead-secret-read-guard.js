#!/usr/bin/env node
// trailhead-secret-read-guard.js: PreToolUse(Read|Bash) hook.
// Restores the `.env`/`.secrets` read protection that three `Read()` deny
// permission rules used to provide, before they were removed (#135). A
// `Read()` deny rule is a PERMISSION rule: under bypass permissions it still
// falls back to a manual approval prompt on Claude Code 2.1.259's new
// `cd-compound-read` check (the same headless-breaking prompt that
// trailhead-search-guard.js exists to route around, see #132-#134). This hook
// gets the same outcome — a secret file can never be read — as a HOOK `deny`
// decision instead, which does not arm that permission-layer prompt at all.
//
// Denies:
//   (a) a Read tool call whose `file_path` basename is a secret pattern; and
//   (b) a Bash command that touches a secret path as a plain positional file
//       operand, an option value (`--file=.env`, `-f .env`, glued `-f.env`),
//       or a `<` (or glued `<file`) redirect target.
// A "secret pattern" is a basename that is exactly `.env`, exactly
// `.secrets`, or matches `.env.<anything>` (e.g. `.env.local`,
// `.env.production`), matched CASE-INSENSITIVELY (`.ENV`/`.SECRETS` are the
// same file on macOS/Windows). Matched on basename, so `app/.env` and
// `./.env.local` are caught the same as a bare `.env`.
//
// #135 follow-up (adversarial review found real false negatives/positives in
// the original naive `.split(/\s+/)` Bash tokenizer):
//   - Finding 1 (glued shell metacharacters, e.g. `cat .env|grep KEY`,
//     `cat .env;echo done`, `cat .env&&echo done`) is fixed by scanning
//     QUOTE-AWARE, STATEMENT-BASED top-level statements (splitStatements),
//     which split on operator characters regardless of surrounding
//     whitespace. `bash -c "cat .env"` / `eval "cat .env"` are fixed by
//     recursing into the quoted sub-command's text as a nested command.
//   - Finding 2 (glued short-option value, `cat -f.env`) is fixed by also
//     testing a value-flag's glued suffix (`token.slice(2)`).
//   - Finding 3 (bare `.env` inside quoted prose, e.g. `git commit -m
//     "document .env usage"`) is fixed by a quote-aware tokenizer that keeps
//     a multi-word quoted phrase as ONE opaque token, never splitting it into
//     separate words.
//   - Finding 4 (a quoted grep PATTERN that happens to look like a secret
//     path, e.g. `grep ".env" config.txt`) is fixed by routing search verbs
//     (grep/rg/ag/sed/awk) through the shared pattern-positional-skipping
//     walk, so the pattern is never mistaken for the file operand.
//   - Finding 5 (case sensitivity) is fixed by lowercasing the basename
//     before the pattern test.
// The quote-aware tokenizer/statement-splitter and the search-verb handling
// are shared with trailhead-search-guard.js via lib/shell-scan.js, so the two
// guards can never drift into two divergent tokenizers again.
//
// #180 fix: `docker`/`podman` `--env-file .env` (or `--env-file=.env`) was a
// false positive: the container RUNTIME reads that file, not the agent. Only
// that flag's value is exempted, and only for docker/podman verbs; see
// ENV_FILE_EXEMPT_VERBS below.
//
// Name-only operand positions: `git check-ignore` / `git ls-files` /
// `git rm --cached` pathspecs and the destination of a one-source `cp`/`mv`
// are names, never contents (the checks that keep a secret OUT of git, and
// `cp .env.example .env`). Only those positions are exempt, behind closed
// option sets that fail closed; see GIT_PATHSPEC_SUBCOMMANDS and
// COPY_NAME_ONLY_FLAGS. Templates (`.env.example`, `.env.*.sample`,
// `.template`, `.dist`) are not secrets: see NON_SECRET_ENV_SUFFIXES.
// Known gap (write class, not read): the cp/mv destination exemption can move
// a link prepared under a non-secret name onto `.env`
// (`ln -s .env.example l && mv l .env`).
//
// Deliberately best-effort on the Bash leg, like the sibling guards: not a
// full shell parser. It does not care about `cd` shape at all (that is
// trailhead-search-guard.js's job) — it only asks "does any token here
// resolve to a secret path", so `cd app && grep x pubspec.yaml` is allowed
// (no secret token present) regardless of the `cd`.
//
// Denies with exit 2 + {"decision":"block","code":...,"reason":...} — same
// wire shape the sibling guards use for a block, which the PreToolUse hook
// contract treats as a deny. Allows everything else. Crash-safe: any error ->
// exit 0 (never wedge the user's workflow). Self-contained (its own
// dependency is the sibling lib/ module, no external packages). Pure
// function exported for tests; runs as a hook when executed directly.

const {
  basename,
  stripQuotes,
  splitStatements,
  tokenize,
  SEARCH_VERB_CONFIG,
  scanArgsSkippingPattern,
} = require('./lib/shell-scan.js');

// --- path helpers ------------------------------------------------------------

// Suffissi finali di `.env.<...>` che indicano un template committato e
// privo di segreti (`.env.example`, `.env.local.sample`, ...), non un segreto.
// Conta solo l'ULTIMO segmento: `.env.example.bak` resta un segreto.
const NON_SECRET_ENV_SUFFIXES = new Set(['example', 'sample', 'template', 'dist']);

// A basename is a "secret pattern" when it is exactly `.env`, exactly
// `.secrets`, or `.env.<something>` (e.g. `.env.local`, `.env.production`),
// matched case-insensitively (`.ENV`/`.Secrets` are the same file on a
// case-insensitive filesystem). Near-misses like `env.sample` (no leading
// dot) or `.environment` (no dot after `.env`) must NOT match, and neither
// must a template whose last segment is in NON_SECRET_ENV_SUFFIXES.
function isSecretBasename(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  if (lower === '.env' || lower === '.secrets') return true;
  if (!/^\.env\..+$/.test(lower)) return false;
  return !NON_SECRET_ENV_SUFFIXES.has(lower.slice(lower.lastIndexOf('.') + 1));
}

// Anche la forma `<rev>:<path>` (`git show HEAD:.env`, `scp host:.env .`):
// il path dopo il primo `:` è letto quanto un operando nudo.
function isSecretPathArg(t) {
  const bare = stripQuotes(t);
  if (!bare) return false;
  if (isSecretBasename(basename(bare))) return true;
  const colon = bare.indexOf(':');
  return colon !== -1 && isSecretBasename(basename(bare.slice(colon + 1)));
}

// --- Bash leg: quote-aware, statement-based scan -----------------------------

// Flags that take a separate-token value which could itself be the secret
// path (`-f .env`, `--file .env`), or (finding #2) a GLUED value on a short
// flag (`-f.env`). Kept small and generic: this hook doesn't need to model
// every tool's flag surface, just the common file-value shapes.
const VALUE_FLAGS = new Set(['-f', '--file']);

// #180: `docker run --env-file .env img` / `docker compose --env-file
// .env.prod up` / `podman run --env-file=.env img` are false positives. The
// CONTAINER RUNTIME reads that file directly to populate the container's
// environment; its contents never pass through the agent, so it is not a
// secret READ by the agent (unlike a bare `cat .env`, which is). Scoped
// narrowly: only the value of `--env-file` is exempt, and only for these
// verbs; every other flag/positional in the same statement (image name,
// `-v`, trailing `cat .env`, etc.) is still scanned exactly as before.
const ENV_FILE_EXEMPT_VERBS = new Set(['docker', 'podman', 'docker-compose', 'podman-compose']);
const ENV_FILE_EXEMPT_FLAGS = new Set(['--env-file']);
const NO_EXEMPT_FLAGS = new Set();
const NO_SKIP = new Set();

// Sottocomandi git che riportano o rimuovono lo stato ignore/tracking di un
// path senza mai stamparne il contenuto: i loro pathspec sono NOMI. Ognuno ha
// il set CHIUSO delle sue opzioni senza valore (`git <sub> -h`, git 2.49):
// qualsiasi altra opzione ritira l'esenzione dall'intero statement (fail
// closed), così il valore di un'opzione non è mai scambiato per un pathspec
// (`-X <file>` legge il file; `--pathspec-from-file=<file>` ne stampa le
// righe nell'errore "did not match"). `requires` = opzione senza la quale il
// sottocomando resta controllato (`git rm` solo con `--cached`).
const GIT_PATHSPEC_SUBCOMMANDS = new Map([
  ['check-ignore', {
    flags: new Set(['-q', '--quiet', '-v', '--verbose', '--stdin', '-z', '-n', '--non-matching', '--no-index', '--index']),
  }],
  ['ls-files', {
    flags: new Set([
      '-z', '-t', '-v', '-f', '-c', '--cached', '-d', '--deleted', '-m', '--modified', '-o', '--others',
      '-i', '--ignored', '-s', '--stage', '-k', '--killed', '-u', '--unmerged', '--directory', '--eol',
      '--no-empty-directory', '--resolve-undo', '--exclude-standard', '--full-name',
      '--recurse-submodules', '--error-unmatch', '--abbrev', '--debug', '--deduplicate', '--sparse',
    ]),
  }],
  ['rm', {
    flags: new Set(['--cached', '-f', '--force', '-n', '--dry-run', '-q', '--quiet', '-r', '--ignore-unmatch', '--sparse']),
    requires: '--cached',
  }],
]);

// Opzioni globali di git (usage line, git 2.49), per trovare il sottocomando.
// Un'opzione con valore consuma la parola successiva salvo forma
// `--opt=value`; un'opzione in nessuno dei due set fa fail closed, così un
// valore non è mai letto come sottocomando (`git -C ls-files show HEAD:.env`
// esegue `show`).
const GIT_GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--bare',
]);

// `cp`/`mv` scrivono la destinazione e non la stampano: un nome segreto che è
// SOLO la destinazione di una copia/spostamento a sorgente singola è un nome
// (`cp .env.example .env`). Vale per esattamente due operandi preceduti da
// opzioni di questo set chiuso; tutto il resto lascia lo statement
// controllato: `-t` (ogni operando diventa sorgente), backup (`-b`,
// `--backup`, `-S`: il vecchio segreto sopravvive come `.env~`), link (`-l`,
// `-s`) o `--exchange` (la destinazione condivide o scambia il segreto). Le
// opzioni devono precedere gli operandi: una in coda è opzione con la
// permutazione GNU ma operando con POSIXLY_CORRECT, quindi quale parola sia
// la destinazione dipenderebbe da un ambiente che l'hook non vede.
const COPY_NAME_ONLY_FLAGS = new Set(['-f', '--force', '-i', '--interactive', '-n', '--no-clobber', '-v', '--verbose']);

// The pattern-first search verbs (grep/rg/ag/sed/awk), shared with
// trailhead-search-guard.js. Their first positional is a PATTERN, not a file
// operand, so it must be skipped before scanning for a secret FILE argument
// (finding #4: `grep ".env" config.txt` reads config.txt, not `.env`).
const SEARCH_VERBS = new Set(Object.keys(SEARCH_VERB_CONFIG));

// `bash -c "<cmd>"` / `sh -c "<cmd>"` / `zsh -c "<cmd>"` / `eval "<cmd>"`: the
// secret read hides inside that quoted string, invisible to a plain
// positional/flag scan (finding #1), so these are recursed into as a nested
// command.
const SHELL_DASH_C_VERBS = new Set(['bash', 'sh', 'zsh', 'ksh']);

// A token can still end with a glued shell metacharacter that splitStatements
// doesn't split on (grouping punctuation left over from a subshell/brace
// group, or a stray backtick closing a command substitution). Strip a run of
// these from the token's tail before basename-testing it, so e.g. the last
// token of `(cat .env)` (`.env)`) still resolves to `.env`.
const TRAILING_PUNCT_RE = /[|;&`)}]+$/;
function stripTrailingPunct(t) {
  return String(t).replace(TRAILING_PUNCT_RE, '');
}

// Scan one already-tokenized statement's argument tokens (verb NOT stripped)
// for a secret path used as a plain positional, an option value
// (`--file=.env`, `-f .env`, glued `-f.env`), or a `<` (or glued `<file`)
// redirect target. Returns the offending token or null. `exemptFlags` (#180)
// names flags whose value must be skipped entirely rather than scanned, in
// both the `--flag=value` and spaced `--flag value` forms.
function scanTokensForSecretPath(tokens, exemptFlags, skipIndices) {
  const exempt = exemptFlags || NO_EXEMPT_FLAGS;
  const skip = skipIndices || NO_SKIP;
  for (let i = 0; i < tokens.length; i++) {
    if (skip.has(i)) continue; // posizione nome-soltanto: mai letta
    const t = stripTrailingPunct(tokens[i]);
    if (!t) continue;

    // `<` redirect: glued (`<.secrets`) or separate-token (`< .secrets`).
    // Never confuse with a heredoc `<<TAG` (already stripped out by
    // splitStatements upstream, but be defensive).
    if (t.startsWith('<') && !t.startsWith('<<')) {
      const glued = t.slice(1);
      if (glued) {
        if (isSecretPathArg(glued)) return glued;
        continue;
      }
      const next = i + 1 < tokens.length ? stripTrailingPunct(tokens[i + 1]) : null;
      if (next && isSecretPathArg(next)) return next;
      continue;
    }

    if (t.startsWith('-') && t !== '-') {
      // `--flag=value` form.
      const eq = t.indexOf('=');
      if (eq > 0) {
        const flagName = t.slice(0, eq);
        if (exempt.has(flagName)) continue; // #180: value never scanned
        const val = t.slice(eq + 1);
        if (isSecretPathArg(val)) return val;
        continue;
      }
      // #180: exempt flag's separate-token value is skipped entirely, not
      // scanned as a plain positional on the next loop iteration.
      if (exempt.has(t)) { i++; continue; }
      // `-f value` / `--file value` (separate-token value).
      if (VALUE_FLAGS.has(t)) {
        const next = i + 1 < tokens.length ? stripTrailingPunct(tokens[i + 1]) : null;
        if (next && !skip.has(i + 1) && isSecretPathArg(next)) return next;
        continue;
      }
      // Glued short-option value (`-f.env`, finding #2): a single-dash flag
      // whose flag letter is a known value flag, with the value glued
      // directly onto it.
      if (!t.startsWith('--') && t.length > 2) {
        const shortFlag = t.slice(0, 2);
        if (VALUE_FLAGS.has(shortFlag)) {
          const glued = t.slice(2);
          if (isSecretPathArg(glued)) return glued;
        }
      }
      continue; // some other flag: not itself a file operand
    }

    // Plain positional (file operand or search pattern token).
    if (isSecretPathArg(t)) return t;
  }
  return null;
}

// Vero se `text` è un'opzione lunga elencata, o un cluster corto (`-ci`) di
// cui OGNI lettera è elencata. `--opt=value`, un'abbreviazione o un cluster
// che contiene un'opzione con valore (`-ciX`) non lo sono.
function isListedFlag(text, flags) {
  if (text.startsWith('--')) return flags.has(text);
  return /^-[A-Za-z]+$/.test(text) && [...text.slice(1)].every((ch) => flags.has(`-${ch}`));
}

// Indice del sottocomando git oltre le opzioni globali, o -1 se lo precede
// un'opzione fuori da GIT_GLOBAL_VALUE_OPTIONS / GIT_GLOBAL_FLAGS.
function gitSubcommandIndex(operands) {
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k];
    if (!t.startsWith('-')) return k;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) { k++; continue; }
    if (GIT_GLOBAL_FLAGS.has(t)) continue;
    const eq = t.indexOf('=');
    const isLongValueForm = t.startsWith('--') && eq !== -1 && GIT_GLOBAL_VALUE_OPTIONS.has(t.slice(0, eq));
    if (!isLongValueForm) return -1;
  }
  return -1;
}

// Indici dei pathspec di un sottocomando in GIT_PATHSPEC_SUBCOMMANDS. git
// permuta le opzioni (una può seguire un pathspec); dopo `--` ogni parola è
// un pathspec. Sottocomando confrontato case-sensitive, come fa git.
function gitPathspecIndices(operands) {
  const sub = gitSubcommandIndex(operands);
  const spec = sub === -1 ? undefined : GIT_PATHSPEC_SUBCOMMANDS.get(operands[sub]);
  if (!spec) return NO_SKIP;
  const pathspecs = new Set();
  let required = spec.requires === undefined;
  let endOfOptions = false;
  for (let k = sub + 1; k < operands.length; k++) {
    const t = operands[k];
    if (endOfOptions || !t.startsWith('-') || t === '-') pathspecs.add(k);
    else if (t === '--') endOfOptions = true;
    else if (!isListedFlag(t, spec.flags)) return NO_SKIP;
    else if (t === spec.requires) required = true;
  }
  return required ? pathspecs : NO_SKIP;
}

// Indice della destinazione di un `cp`/`mv` a sorgente singola (vedi
// COPY_NAME_ONLY_FLAGS).
function copyDestinationIndices(operands) {
  const positional = [];
  let endOfOptions = false;
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k];
    if (endOfOptions || !t.startsWith('-') || t === '-') positional.push(k);
    else if (positional.length) return NO_SKIP; // opzione o `--` dopo un operando
    else if (t === '--') endOfOptions = true;
    else if (!isListedFlag(t, COPY_NAME_ONLY_FLAGS)) return NO_SKIP;
  }
  return positional.length === 2 ? new Set([positional[1]]) : NO_SKIP;
}

// Indici dei token (verbo incluso, indice 0) che lo statement consuma come
// NOME e mai come CONTENUTO: pathspec di git check-ignore/ls-files/rm
// --cached e destinazione di cp/mv. Solo queste posizioni saltano il
// controllo; ogni altro token resta controllato, quindi l'esenzione non può
// riciclare una lettura altrove nello statement.
function nameOnlyTokenIndices(bin, tokens) {
  const operands = tokens.slice(1).map((t) => stripQuotes(stripTrailingPunct(t)));
  let indices = NO_SKIP;
  if (bin === 'git') indices = gitPathspecIndices(operands);
  else if (bin === 'cp' || bin === 'mv') indices = copyDestinationIndices(operands);
  return new Set([...indices].map((k) => k + 1));
}

// Does `stmtTokens` invoke `bash -c "<cmd>"` / `sh -c "<cmd>"` / `eval
// "<cmd>"` (etc.)? If so, return the inner command TEXT (quotes stripped, not
// yet re-tokenized) so the caller can recurse into it as a nested command.
// Best-effort: only the common single-quoted-argument idiom, not every way a
// shell can be told to execute a string.
function extractNestedCommand(stmtTokens) {
  if (!stmtTokens.length) return null;
  const bin = basename(stmtTokens[0]);
  if (bin === 'eval') {
    const rest = stmtTokens.slice(1);
    if (!rest.length) return null;
    return stripQuotes(rest.join(' '));
  }
  if (SHELL_DASH_C_VERBS.has(bin)) {
    const cIdx = stmtTokens.indexOf('-c');
    if (cIdx === -1 || cIdx + 1 >= stmtTokens.length) return null;
    return stripQuotes(stmtTokens.slice(cIdx + 1).join(' '));
  }
  return null;
}

// Scan a single top-level statement for a secret path. Recurses into a
// bash -c/eval quoted sub-command first (finding #1), routes grep/rg/ag/sed/
// awk through the shared pattern-skipping walk (finding #4), and falls back
// to the plain per-token walk for everything else (cat, head, redirects,
// etc.).
function scanStatementForSecretPath(stmt) {
  const tokens = tokenize(stmt);
  if (!tokens.length) return null;

  const nested = extractNestedCommand(tokens);
  if (nested) {
    const hit = scanBashForSecretPath(nested);
    if (hit) return hit;
    // fall through: also scan the wrapper statement's own tokens (e.g. a
    // stray `-f .env` on the wrapper itself) for defence in depth.
  }

  const bin = basename(tokens[0]);
  if (SEARCH_VERBS.has(bin)) {
    return scanArgsSkippingPattern(tokens.slice(1), SEARCH_VERB_CONFIG[bin], isSecretPathArg);
  }
  // #180: docker/podman (incl. `docker compose` as a subcommand, and the
  // standalone docker-compose/podman-compose binaries) get --env-file's value
  // exempted; every other verb keeps today's behaviour unchanged.
  const exempt = ENV_FILE_EXEMPT_VERBS.has(bin) ? ENV_FILE_EXEMPT_FLAGS : NO_EXEMPT_FLAGS;
  return scanTokensForSecretPath(tokens, exempt, nameOnlyTokenIndices(bin, tokens));
}

// Walk the command's top-level statements (quote-aware; `|`, `;`, `&&`,
// `||`, and newlines all split, even with no surrounding whitespace, e.g.
// `cat .env|grep KEY`) looking for a secret path used as a plain positional,
// an option value, or a `<` redirect target. Returns the offending token
// (quotes/punctuation not necessarily stripped) or null. Best-effort: not a
// full shell parser.
function scanBashForSecretPath(cmd) {
  const statements = splitStatements(cmd);
  for (const stmt of statements) {
    const hit = scanStatementForSecretPath(stmt);
    if (hit) return hit;
  }
  return null;
}

// --- top-level detection -----------------------------------------------------

// Detect a secret-file read across a Read or Bash tool call. Returns
// { path } on a hit, or null. Pure, exported for tests.
function detectSecretRead(toolName, toolInput) {
  const input = toolInput || {};
  if (toolName === 'Read') {
    const p = input.file_path;
    if (p && isSecretPathArg(String(p))) return { path: String(p) };
    return null;
  }
  if (toolName === 'Bash') {
    const cmd = input.command || '';
    const hit = scanBashForSecretPath(cmd);
    return hit ? { path: hit } : null;
  }
  return null;
}

function block(hit) {
  const reason =
    `trailhead secret-read guard: blocked a read of secret file \`${hit.path}\` ` +
    '(.env / .env.* / .secrets). This replaces the Read() deny permission rules ' +
    "removed in #135 with a hook-level deny, so secrets stay unreadable without " +
    "arming Claude Code 2.1.259's cd-compound-read approval prompt. If this file " +
    'genuinely needs inspecting, do so outside the agent session.';
  process.stdout.write(JSON.stringify({ decision: 'block', code: 'SECRET_READ_BLOCKED', reason }));
  process.exit(2);
}

function run(data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    process.exit(0); // unparseable input: nothing to gate
  }
  try {
    const hit = detectSecretRead(parsed.tool_name, parsed.tool_input);
    if (hit) block(hit);
  } catch {
    // fall through to allow: a guard must never wedge the workflow
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends -> give up
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { detectSecretRead };
