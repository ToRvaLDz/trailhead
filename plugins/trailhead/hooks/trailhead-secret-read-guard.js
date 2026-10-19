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
// #214 fix: a secret read inside a command substitution was missed when the
// substitution sat in double quotes (`echo "$(cat .env)"`, `x="$(cat .env)"`,
// `echo "$(true; cat .env)"`): the quoted token hid it, and the splitter cut
// inside the `$(..)`. Each outermost `$(..)` / `<(..)` / `>(..)` body (from
// substitutionBodies in lib/shell-scan.js) is now also scanned as a command,
// off a depth- and size-capped work-list.
//
// #216 fix: the same miss for backtick substitutions (`echo "`cat .env`"`,
// `x="`cat .env`"`, `echo "${x:-`cat .env`}"`). scanLine now tracks a backtick
// span and substitutionBodies returns its body (unescaped as the shell would
// run it) alongside the `$(..)` ones, so the work-list scans it too.
//
// #218 fix: the same miss for a substitution in the body of an UNQUOTED heredoc
// (`cat <<EOF` with `$(cat .env)` or a backtick inside): the shell runs it, but
// heredoc bodies are data to the splitter and were never lexed. Each unquoted
// body is now lexed as the shell reads one (heredocSubstitutionBodies: quotes
// are literal there) and its outermost substitution bodies join the work-list.
// A quoted delimiter (`<<'EOF'`) and an escaped `\$(..)` stay literal.
//
// #223 fix: a heredoc body fed to a shell interpreter on stdin (`bash <<'EOF'`,
// `sh <<EOF`, `cat <<EOF | bash`) is a script the shell runs, whatever the
// delimiter quoting, but bodies were only ever data. Each statement is now paired
// with its own bodies by position (as trailhead-secret-guard.js does); when a
// statement of its pipeline invokes a shell from a closed set, those bodies join
// the work-list as commands. No wrappers (sudo, exec, nohup): out of scope.
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
// #273: a command carried in a git config value (`git -c alias.x="!cat .env" x`,
// `-c core.pager=...`, `--config-env=core.pager=VAR` with VAR assigned in the same
// statement) is scanned as a nested command, like `bash -c`; `--config-env` on a
// command key whose variable is not assigned there denies as unmodelled.
//
// #227: a construct the guard cannot interpret with certainty (eval, source / `.`, a
// bash 5.3 `${ cmd; }`, printf -v, a function definition, an alias, a quoted gh api body
// key, a backslash-newline inside a word) is not emulated. As a FINAL gate, after the
// precise scan, one that sits next to a secret-looking piece (`.env`, `.e""nv`, ...)
// denies with SECRET_READ_UNMODELLED_CONSTRUCT and asks for the simple form; with no
// such piece (`. venv/bin/activate && make`) it passes. The closed list is
// lib/unmodelled.js.
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
  splitStatementsWithSeparators,
  countHeredocs,
  skipEnvPrefix,
  substitutionBodies,
  heredocBodies,
  heredocSubstitutionBodies,
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
// `--opt=value`. Un'opzione in nessuno dei due set NON ferma la camminata
// (vedi walkGitGlobals): per il sottocomando esenta nulla (fail closed, un
// valore non è mai letto come sottocomando: `git -C ls-files show HEAD:.env`
// esegue `show`), per gli `-c` successivi li lascia comunque controllati.
const GIT_GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']);
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--bare', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--exec-path', '--html-path', '--man-path', '--info-path',
]);
// Flag che accetta anche la forma `--opt=value` ma mai un valore separato.
const GIT_GLOBAL_EQ_FLAGS = new Set(['--exec-path', '--list-cmds']);

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

// UNICA camminata sulle opzioni globali di git, condivisa da gitSubcommandIndex
// e da extractGitConfigCommands così le due non divergono. Restituisce
// { sub, known, configs }: `sub` = indice del primo operando non-opzione (-1 se
// assente), `known` = false se la camminata ha incontrato un'opzione fuori dai
// set (allora nessuna esenzione per il sottocomando), `configs` = i valori
// `-c` / `-ckey=value` / `--config-env` visti prima del sottocomando.
// Un'opzione sconosciuta non interrompe la camminata: si tratta come flag fino al
// primo operando non-opzione (fail toward scanning).
function walkGitGlobals(operands) {
  const out = { sub: -1, known: true, configs: [] };
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k];
    if (!t.startsWith('-') || t === '-') { out.sub = k; return out; }
    if (t === '-c' || t === '--config-env') {
      if (k + 1 >= operands.length) { out.known = false; return out; }
      out.configs.push({ kind: t === '-c' ? 'c' : 'env', value: operands[++k], sample: `${t} ${operands[k]}` });
    } else if (t.startsWith('--config-env=')) {
      out.configs.push({ kind: 'env', value: t.slice('--config-env='.length), sample: t });
    } else if (isGluedGitConfig(t)) {
      out.configs.push({ kind: 'c', value: t.slice(2), sample: t }); // #273: `-ckey=value`
    } else if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) {
      if (k + 1 >= operands.length) { out.known = false; return out; }
      k++; // `-C <path>` and friends: the value is not a config
    } else if (GIT_GLOBAL_FLAGS.has(t)) {
      // known flag
    } else {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      const longForm = t.startsWith('--') && eq !== -1 && (GIT_GLOBAL_VALUE_OPTIONS.has(name) || GIT_GLOBAL_EQ_FLAGS.has(name));
      if (!longForm) out.known = false; // unknown option: treated as a flag, no exemption
    }
  }
  return out;
}

// Indice del sottocomando git oltre le opzioni globali, o -1 se lo precede
// un'opzione sconosciuta o manca.
function gitSubcommandIndex(operands) {
  const w = walkGitGlobals(operands);
  return w.known ? w.sub : -1;
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

// #273: `git -c key=value` / `--config-env=key=ENV` can name a COMMAND git runs
// (an alias with `!`, a pager, an editor, an ssh command, ...), which the plain
// token walk only tests as a file name. The key families git runs as a command,
// matched on the lowercased key (section and variable are case-insensitive; a
// lowercased middle segment only widens a wildcard). `bang` = the value is a
// command only when it starts with `!` (the `!` is not part of the command).
const GIT_COMMAND_KEYS = [
  { re: /^alias\..+$/, bang: true },
  { re: /^core\.(pager|editor|sshcommand|fsmonitor)$/ },
  { re: /^pager\..+$/ },
  { re: /^sequence\.editor$/ },
  { re: /^diff\.external$/ },
  { re: /^diff\..+\.textconv$/ },
  { re: /^filter\..+\.(clean|smudge|process)$/ },
  { re: /^credential\.(.+\.)?helper$/, bang: true },
  { re: /^gpg\.(.+\.)?program$/ },
];

// `-ckey=value` (value glued on, no space).
function isGluedGitConfig(t) {
  return t.length > 2 && t.startsWith('-c') && !t.startsWith('--');
}

// The word as the shell hands it over: quote pairs removed, their content kept
// (`alias.x="!cat .env"` -> `alias.x=!cat .env`); the other quote kind inside a
// pair stays literal. No escapes or expansions: best-effort like the rest.
function shellUnquote(word) {
  let out = '';
  let q = null;
  for (const ch of String(word)) {
    if (q) { if (ch === q) q = null; else out += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else out += ch;
  }
  return out;
}

// The command text a git config value carries for `key`, or null when the key
// is not command-valued (or `!`-less where the `!` is required).
function isGitCommandKey(key) {
  return GIT_COMMAND_KEYS.some((k) => k.re.test(key.toLowerCase()));
}

function gitConfigCommand(key, value) {
  const spec = GIT_COMMAND_KEYS.find((k) => k.re.test(key.toLowerCase()));
  if (!spec) return null;
  if (spec.bang) return value.startsWith('!') && value.length > 1 ? value.slice(1) : null;
  return value ? value : null;
}

// Splits `NAME=value` at the first `=` (null when there is none or the name is empty).
function splitAssignment(kv) {
  const eq = kv.indexOf('=');
  return eq <= 0 ? null : [kv.slice(0, eq), kv.slice(eq + 1)];
}

// Every command text carried in the git global options of a statement, from
// `-c key=value`, `-ckey=value` and `--config-env[=| ]key=ENV`, plus the
// `--config-env` forms on a command-valued key whose ENV the statement does not
// assign (`unresolved`: the guard cannot see the value, so it fails closed).
// ENV is resolved from the statement's own leading NAME=value assignments.
function extractGitConfigCommands(tokens) {
  const found = { commands: [], unresolved: [] };
  const first = skipEnvPrefix(tokens);
  if (first >= tokens.length || basename(shellUnquote(tokens[first])) !== 'git') return found;
  const env = new Map();
  for (const a of tokens.slice(0, first)) {
    const kv = splitAssignment(shellUnquote(a));
    if (kv) env.set(kv[0], kv[1]);
  }
  const add = (key, value) => {
    const cmd = gitConfigCommand(key, value);
    if (cmd) found.commands.push(cmd);
  };
  const operands = tokens.slice(first + 1).map(shellUnquote);
  for (const cfg of walkGitGlobals(operands).configs) {
    const kv = splitAssignment(cfg.value);
    if (!kv) continue;
    if (cfg.kind === 'c') { add(kv[0], kv[1]); continue; }
    if (!isGitCommandKey(kv[0])) continue;
    if (env.has(kv[1])) add(kv[0], env.get(kv[1])); else found.unresolved.push(cfg.sample);
  }
  return found;
}

// The unmodelled-hit shape (lib/unmodelled.js) for a `--config-env` on a command key whose
// variable the statement does not assign.
const GIT_CONFIG_ENV_UNMODELLED = (sample) => ({
  id: 'git-config-env',
  label: 'a git --config-env on a command-valued key whose variable is not assigned in the same statement',
  hint: 'assign it in the same statement (`VAR="cmd" git --config-env=key=VAR ...`) or pass the command with `git -c key=cmd`',
  sample,
});

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

  // #273: a command carried in a git config value (`-c core.pager="cat .env"`).
  const git = extractGitConfigCommands(tokens);
  for (const text of git.commands) {
    const hit = scanBashForSecretPath(text);
    if (hit) return hit;
  }
  if (git.unresolved.length) {
    return { path: git.unresolved[0], unmodelled: GIT_CONFIG_ENV_UNMODELLED(git.unresolved[0]) };
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

// #214: substitution bodies are scanned off an explicit work-list (no
// recursion, so no stack overflow) under a cap on nesting depth and on the
// total bytes of bodies scanned. Past the cap the remaining text is checked
// crudely instead (see crudeSecretToken): the guard fails toward blocking.
const MAX_SUB_DEPTH = 32;
const MAX_SUB_BYTES = 64 * 1024;
const CRUDE_SPLIT_RE = /[\s"'`()$;|&<>{}=]+/;

// Fallback when the cap is hit: split the unscanned text on whitespace, quotes,
// parens and operators, and return the first piece that is a secret path.
function crudeSecretToken(text) {
  for (const piece of text.split(CRUDE_SPLIT_RE)) {
    if (piece && isSecretPathArg(piece)) return piece;
  }
  return null;
}

// #223: shells that read a script from stdin (closed set, no wrappers).
const STDIN_SCRIPT_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
// Reserved words that may precede the command word (no grouping, no wrappers).
const LEADING_KEYWORDS = new Set(['then', 'do', 'else', 'time', '!']);
// `env` options whose value is the next token (separate form, no `=`).
const ENV_VALUE_OPTIONS = new Set(['-u', '-C', '--unset', '--chdir']);

// True when the statement runs one of those shells: after leading NAME=value
// assignments, an optional `env` (with its NAME=value and -option words), the
// command word's basename is in the set. Flags after it do not matter.
function invokesInterpreter(stmt) {
  const tokens = tokenize(stmt);
  let i = 0;
  while (i < tokens.length && LEADING_KEYWORDS.has(tokens[i])) i++;
  i += skipEnvPrefix(tokens.slice(i));
  if (i < tokens.length && basename(stripQuotes(tokens[i])) === 'env') {
    i++;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i].startsWith('-'))) {
      i += ENV_VALUE_OPTIONS.has(tokens[i]) ? 2 : 1;
    }
  }
  return i < tokens.length && STDIN_SCRIPT_INTERPRETERS.has(basename(stripQuotes(tokens[i])));
}

// Walk the command's top-level statements (quote-aware; `|`, `;`, `&&`,
// `||`, and newlines all split, even with no surrounding whitespace, e.g.
// `cat .env|grep KEY`) looking for a secret path used as a plain positional,
// an option value, or a `<` redirect target. Returns the offending token
// (quotes/punctuation not necessarily stripped) or null. Best-effort: not a
// full shell parser.
function scanBashForSecretPath(cmd) {
  const work = [{ text: String(cmd), depth: 0 }];
  let bytes = 0;
  for (let w = 0; w < work.length; w++) {
    const { text, depth } = work[w];
    if (depth > 0) bytes += text.length;
    if (depth > MAX_SUB_DEPTH || bytes > MAX_SUB_BYTES) {
      const hit = crudeSecretToken(text);
      if (hit) return hit;
      continue;
    }
    const bodies = heredocBodies(text);
    const entries = splitStatementsWithSeparators(text);
    let next = 0;
    const pushed = new Set(); // bodies already scanned whole as commands
    let pipe = []; // consecutive statements joined by `|`
    const flush = () => {
      if (pipe.some((p) => invokesInterpreter(p.text))) {
        for (const doc of pipe.flatMap((p) => p.docs)) {
          work.push({ text: doc.body, depth: depth + 1 });
          pushed.add(doc);
        }
      }
      pipe = [];
    };
    for (const entry of entries) {
      const hit = scanStatementForSecretPath(entry.text);
      if (hit) return hit;
      const docs = bodies.slice(next, next + countHeredocs(entry));
      next += docs.length;
      pipe.push({ text: entry.text, docs });
      if (entry.sep !== '|') flush();
    }
    flush();
    // #214: a statement cut inside `"$(..)"` loses the closing context, and a
    // double-quoted token hides its body from the per-token walk; scan each
    // outermost substitution body as a command of its own (nested ones next).
    for (const body of substitutionBodies(text)) work.push({ text: body, depth: depth + 1 });
    // #218: an unquoted heredoc body is data to the splitter, but the shell runs
    // the substitutions in it; a quoted delimiter makes the body literal.
    // (#223: a body already pushed whole as a command needs no second push.)
    for (const doc of bodies) {
      if (doc.quoted || pushed.has(doc)) continue;
      for (const body of heredocSubstitutionBodies(doc.body)) work.push({ text: body, depth: depth + 1 });
    }
  }
  return null;
}

// --- unmodelled constructs (#227) ----------------------------------------------

// Does a text hold a secret-looking piece once live backslash-newlines are joined and
// quote characters dropped (`.e""nv` is `.env` to the shell)? Crude by design: the
// precise scan above is exact and runs first, this only has to catch what it cannot see.
function crudeSecretPiece(text) {
  return crudeSecretToken(String(text).replace(/\\\n/g, '').replace(/["'`]/g, ''));
}

// A construct the guard cannot interpret (eval, source / `.`, a bash 5.3 `${ cmd; }`,
// printf -v, a function definition, an alias, a quoted gh api body key, a backslash-newline
// inside a word) next to a secret-looking piece: { hit, piece } or null. The piece only has
// to sit in the construct's own statement or in the code it hides, which is not proof of a
// read (`printf -v x %s .env` blocks too): the uncertain shape is blocked and the simple
// form asked for, not emulated.
function unmodelledSecretPiece(cmd) {
  let lib; // loaded lazily: a missing or broken lib only switches this gate off
  try {
    lib = require('./lib/unmodelled.js');
  } catch {
    return null;
  }
  for (const hit of lib.findUnmodelled(cmd)) {
    if (hit.id === 'api-field') continue; // a body-write concern (body-guard), not a read
    const piece = crudeSecretPiece(hit.stmt) || crudeSecretPiece(hit.payload);
    if (piece) return { hit, piece };
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
    if (hit) return typeof hit === 'object' ? hit : { path: hit }; // object: an unmodelled hit (#273)
    const um = unmodelledSecretPiece(cmd); // a final gate: the precise scan keeps priority
    return um ? { path: um.piece, unmodelled: um.hit } : null;
  }
  return null;
}

function blockUnmodelled(hit) {
  let redact; // the secret-guard's redactor; without it the message omits the sample
  try {
    ({ redact } = require('./trailhead-secret-guard.js'));
  } catch {
    redact = undefined;
  }
  const reason = require('./lib/unmodelled.js').unmodelledReason('secret-read guard', 'that it does not read a secret file (.env / .env.* / .secrets)', hit.unmodelled, redact);
  process.stdout.write(JSON.stringify({ decision: 'block', code: 'SECRET_READ_UNMODELLED_CONSTRUCT', reason }));
  process.exit(2);
}

function block(hit) {
  if (hit.unmodelled) blockUnmodelled(hit);
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
