#!/usr/bin/env node
// trailhead-install-guard.js: PreToolUse(Bash) hook.
// Slopsquatting barrier. trailhead's executor/fix agents can install packages
// (npm / PyPI / crates.io / Go / RubyGems) while resolving a ticket, so a
// hallucinated or typosquatted package NAME could be fetched silently. This gate
// BLOCKS any public-registry install that names a package until the agent has
// vetted the name, then instructs it to verify legitimacy (typosquat similarity,
// package age, download counts, repo metadata) and checkpoint the human on a
// suspicious result (block-and-ask). A vetted install proceeds by re-running the
// command prefixed with the sentinel `TRAILHEAD_VERIFIED_INSTALL=1`.
// Only a NAMED install is gated: installs with no typed name (bare `npm install`,
// `npm ci`, `install --frozen-lockfile` / `--immutable` with no package, `pip install -r`,
// `cargo build`, `go mod download`, `bundle install`) and local paths / URLs /
// VCS refs carry no typed name and pass through. A file-like name (`foo.txt`,
// `x.tgz`) passes only when it is a path (`./x`, `sub/x`, `/x`, `~/x`) or exists
// on disk (relative to the command's cwd); otherwise it is a typed name and is gated.
// The on-disk check resolves against the hook's cwd; it does not follow a
// preceding `cd` in the same command. Command wrappers (`sudo`, `time`, `env`, `nohup`, `xargs`, `timeout`, `nice`, `stdbuf`,
// `setsid`, `ionice`, `doas`, `command`, `exec`) are peeled, with their own flags, so `sudo npm install foo` is gated like the bare form. Parsing is quote-aware (shared
// lib/shell-scan.js): text inside quotes or a heredoc (`echo "x; npm i foo"`) is
// never a command, and redirections (`2>&1`, `> log`) are never package names.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Crash-safe: any error → exit 0 (never wedge the user's workflow).
// Self-contained (its only dependency is the sibling lib/ module). Pure functions (incl. evaluate) exported for tests
// and the merged trailhead-bash-guards.js; runs as a hook when executed directly.

const fs = require('fs');
const path = require('path');
const { basename, splitStatements, tokenize, stripQuotes, stripRedirections } = require('./lib/shell-scan.js');

const SENTINEL = /(?:^|\s)TRAILHEAD_VERIFIED_INSTALL=1(?:\s|$)/;

// Per-ecosystem: the binaries that own it, and the install verbs that fetch a
// named package. `add` covers pnpm/yarn/bun/uv/poetry/cargo; `install`/`i` npm
// and pip; `get`/`install` go.
const ECOSYSTEMS = {
  npm: { bins: ['npm', 'pnpm', 'yarn', 'bun'], verbs: ['install', 'i', 'add'] },
  pip: { bins: ['pip', 'pip3', 'pipx', 'uv', 'poetry'], verbs: ['install', 'add'] },
  crates: { bins: ['cargo'], verbs: ['add', 'install'] },
  go: { bins: ['go'], verbs: ['get', 'install'] },
  gem: { bins: ['gem'], verbs: ['install'] },
};

// Flags that consume a SEPARATE-TOKEN value (a file, url, or dir), so that value
// is never mistaken for a package name (e.g. `pip install -r requirements.txt`).
const VALUE_FLAGS = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable',
  '-i', '--index-url', '--extra-index-url', '-f', '--find-links',
  '-t', '--target', '--prefix', '--root', '--python', '-d', '--dest',
  '-w', '--workspace', '--registry', '-C', '--directory', '--chdir',
  '--no-binary', '--only-binary',
  '--filter', '-F', // pnpm workspace selector: its value is a project, not a package
]);

// Command wrappers that run the rest of the line as a command, mapped to the
// flags that consume a SEPARATE-TOKEN value (so it is not read as the command).
// Attached forms (`-uroot`, `--user=root`, GNU xargs `-i`/`-e`/`-l`) need no entry.
const WRAPPERS = {
  sudo: new Set([
    '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
    '-U', '--other-user', '-r', '--role', '-t', '--type', '-D', '--chdir', '-R', '--chroot',
    '-T', '--command-timeout',
  ]),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0']), // -S handled apart
  time: new Set(['-f', '--format', '-o', '--output']),
  nohup: new Set(),
  xargs: new Set([
    '-n', '--max-args', '-I', '-a', '--arg-file', '-d', '--delimiter', '-E', '-L', '--max-lines',
    '-P', '--max-procs', '-s', '--max-chars',
  ]),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']), // + one DURATION operand
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  setsid: new Set(),
  ionice: new Set(['-c', '--class', '-n', '--classdata']),
  doas: new Set(['-a', '-C', '-u']),
  command: new Set(), // -v / -V only look a name up: see isLookupFlag
  exec: new Set(['-a']),
};
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// How a wrapper flag consumes its value. Returns { next } (value is the NEXT
// token), { attached } (value is inside this token) or {} (flagless). A short
// cluster is read like getopt: the first value-taking letter ends it, so `-nu root`
// takes the next token and `-uroot` carries its value attached.
function flagValue(f, valueFlags) {
  if (f.startsWith('--')) {
    const eq = f.indexOf('=');
    if (eq !== -1) return { attached: f.slice(eq + 1) };
    return valueFlags.has(f) ? { next: true } : {};
  }
  for (let k = 1; k < f.length; k++) {
    if (!valueFlags.has('-' + f[k])) continue;
    return k === f.length - 1 ? { next: true } : { attached: f.slice(k + 1) };
  }
  return {};
}

// `env -S` / `--split-string`: its payload IS the command line, not a flag value.
function isSplitFlag(f) {
  if (f.startsWith('--')) return f === '--split-string' || f.startsWith('--split-string=');
  for (let k = 1; k < f.length; k++) {
    if (f[k] === 'S') return true;
    if ('uCa'.includes(f[k])) return false; // value letter first: S is part of its value
  }
  return false;
}

// `command -v` / `-V` (also inside a cluster like `-pv`) only describe a name and
// execute nothing, so nothing follows that can be an install.
function isLookupFlag(f) {
  return !f.startsWith('--') && /[vV]/.test(f);
}

// The text of an `env -S` payload token. A double-quoted payload (outer quotes
// stripped) also loses its bash escapes (`\$`, `\``, `\"`, `\\`); single-quoted
// text is literal. Local on purpose: the shared stripQuotes is left as is.
function payloadText(payload) {
  const p = payload || '';
  const stripped = stripQuotes(p);
  const dq = p.length >= 2 && p.startsWith('"') && p.endsWith('"');
  return dq ? stripped.replace(/\\([$`"\\])/g, '$1') : stripped;
}

// The real command, past leading `NAME=value` assignments and any (nested) wrapper
// with its flags. Returns { toks, i }: toks may be rewritten when an `env -S`
// payload is re-tokenized; i is toks.length when nothing is left.
function skipWrappers(input) {
  let toks = input;
  let i = 0;
  for (;;) {
    while (i < toks.length && ENV_ASSIGN.test(toks[i])) i++;
    const wrapper = basename(toks[i] || '');
    const valueFlags = WRAPPERS[wrapper];
    if (!valueFlags) return { toks, i };
    i++; // past the wrapper
    while (i < toks.length && toks[i].startsWith('-')) {
      const f = toks[i++];
      if (f === '--') break; // end of the wrapper's options
      if (wrapper === 'env' && isSplitFlag(f)) {
        const eq = f.indexOf('=');
        const sIdx = f.indexOf('S');
        let payload;
        if (f.startsWith('--')) payload = eq !== -1 ? f.slice(eq + 1) : toks[i++];
        else payload = sIdx === f.length - 1 ? toks[i++] : f.slice(sIdx + 1);
        toks = [...tokenize(payloadText(payload)), ...toks.slice(i)];
        i = 0; // the payload and the rest now form the command line
        break;
      }
      if (wrapper === 'command' && isLookupFlag(f)) return { toks, i: toks.length };
      if (flagValue(f, valueFlags).next) i++; // consume its separate-token value
    }
    if (wrapper === 'timeout' && i < toks.length) i++; // the DURATION operand
  }
}

// A file-like name is local only when it is a path or exists on disk. A leading
// `@` is a scoped npm name, never a path.
function isLocalFile(t, opts) {
  if (t.startsWith('@')) return false;
  if (t.includes('/')) return true;
  const exists = (opts && opts.exists) || fs.existsSync;
  return exists(path.resolve((opts && opts.cwd) || process.cwd(), t));
}

// A positional that is NOT a public-registry name: local path, url, vcs ref, or a
// file artifact. Go module paths (example.com/foo) look url-ish but ARE the named
// module, so for go only a leading . / ~ disqualifies.
function isLocalOrUrl(t, ecosystem, opts) {
  if (t.startsWith('.') || t.startsWith('/') || t.startsWith('~')) return true;
  if (ecosystem === 'go') return false; // a bare module path is the name; gate it
  if (t.includes('://')) return true;
  if (/^(?:git\+|file:|https?:|hg\+|svn\+|bzr\+)/.test(t)) return true;
  if (/\.(?:tgz|tar\.gz|whl|gz|zip|txt|toml|lock|cfg)$/.test(t)) return isLocalFile(t, opts);
  return false;
}

// Best-effort bare name for the human-facing reason (detection does not depend on
// this being exact). Strips pip version specifiers / extras and npm @version.
function bareName(t) {
  let n = t.split(/[=<>~!\[]/)[0]; // pip: pkg==1, pkg>=1, pkg[extra]
  if (n.startsWith('@')) {
    const at = n.indexOf('@', 1); // scoped @scope/pkg@1 → cut the version @
    if (at !== -1) n = n.slice(0, at);
  } else {
    const at = n.indexOf('@'); // npm pkg@1.2.3
    if (at !== -1) n = n.slice(0, at);
  }
  return n;
}

// Positional package names among the arguments after the verb (redirections
// already removed). Quotes are stripped so `"lodash"` is the name `lodash`.
function collectPackages(args, ecosystem, opts) {
  const packages = [];
  for (let j = 0; j < args.length; j++) {
    const t = args[j];
    if (t.startsWith('-')) {
      if (VALUE_FLAGS.has(t)) j++; // consume its separate-token value
      continue;
    }
    const name = stripQuotes(t);
    if (!name || name === '&' || isLocalOrUrl(name, ecosystem, opts)) continue;
    const bare = bareName(name);
    if (bare) packages.push(bare);
  }
  return packages;
}

// Detect a public-registry install that NAMES at least one package, in a single
// shell statement. Returns { ecosystem, packages: [names] } or null.
function detectSegment(stmt, opts) {
  const { toks, i: start } = skipWrappers(tokenize(stmt));
  let i = start; // env prefix + sudo/time/env/nohup/xargs
  if (i >= toks.length) return null;

  const bin = basename(toks[i]);
  let ecosystem = null;
  for (const [name, spec] of Object.entries(ECOSYSTEMS)) {
    if (spec.bins.includes(bin)) { ecosystem = name; break; }
  }
  // `python -m pip install …` → treat as pip.
  if (!ecosystem && /^python3?$/.test(bin)) {
    if (toks[i + 1] === '-m' && /^pip3?$/.test(toks[i + 2] || '')) {
      ecosystem = 'pip';
      i += 2; // land on `pip`
    } else {
      return null;
    }
  }
  if (!ecosystem) return null;
  i++; // past the binary (or the `pip` peeled above)

  // `uv pip install …` → peel the `pip`.
  if (bin === 'uv' && toks[i] === 'pip') i++;

  const verb = toks[i];
  if (!ECOSYSTEMS[ecosystem].verbs.includes(verb)) return null;
  i++;

  const args = stripRedirections(toks.slice(i));
  // A lockfile install (`--frozen-lockfile`, `--immutable`) carries no positional,
  // so it yields no package here; a flag never excuses a name typed beside it.
  const packages = collectPackages(args, ecosystem, opts);
  if (packages.length === 0) return null; // lockfile/manifest install: nothing typed
  return { ecosystem, packages };
}

// Agents chain commands (`cd app && npm install foo`), so check every shell
// statement, not just the first. splitStatements is quote- and heredoc-aware, so
// a separator or install text inside quotes / a heredoc body is not a statement.
// Returns the first statement's hit, or null.
function detectInstall(cmd, opts) {
  for (const stmt of splitStatements(cmd)) {
    const hit = detectSegment(stmt, opts);
    if (hit) return hit;
  }
  return null;
}

// The agent's "I have vetted these" acknowledgement.
function isVerified(cmd) {
  return SENTINEL.test(String(cmd));
}

function blockVerdict(hit) {
  const list = hit.packages.join(', ');
  const reason =
    `trailhead: this ${hit.ecosystem} install names package(s) not yet vetted (${list}). ` +
    'Guard against slopsquatting before installing: verify each package is legitimate, weighing ' +
    'name / typosquat similarity to popular packages, package age / first-seen date, download counts / popularity, ' +
    'and repository metadata (present and matching). ' +
    'STOP and ask the human on anything suspicious (block-and-ask): do not install on your own judgement. ' +
    'Once vetted, re-run the exact command prefixed with `TRAILHEAD_VERIFIED_INSTALL=1` to proceed.';
  return { kind: 'block', payload: { decision: 'block', code: 'UNVETTED_PACKAGE_INSTALL', reason } };
}

// Pure verdict for one command: {kind:'allow'} or {kind:'block', payload}. Never
// exits or writes; any internal error falls through to allow.
function evaluate(cmd, opts) {
  try {
    if (isVerified(cmd)) return { kind: 'allow' }; // agent has vetted these
    const hit = detectInstall(cmd, { cwd: opts && opts.cwd });
    if (hit) return blockVerdict(hit);
  } catch {
    // fall through to allow: a guard must never wedge the workflow
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
    process.exit(0); // unparseable input: nothing to gate
  }
  const v = evaluate(cmd, { cwd });
  if (v.kind === 'block') {
    process.stdout.write(JSON.stringify(v.payload));
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  const timer = setTimeout(() => process.exit(0), 5000); // stdin never ends → give up
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    run(data);
  });
}

module.exports = { detectInstall, isVerified, evaluate };
