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
// VCS refs carry no typed name and pass through. Parsing is quote-aware (shared
// lib/shell-scan.js): text inside quotes or a heredoc (`echo "x; npm i foo"`) is
// never a command, and redirections (`2>&1`, `> log`) are never package names.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Crash-safe: any error → exit 0 (never wedge the user's workflow).
// Self-contained (its only dependency is the sibling lib/ module). Pure functions (incl. evaluate) exported for tests
// and the merged trailhead-bash-guards.js; runs as a hook when executed directly.

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

// A positional that is NOT a public-registry name: local path, url, vcs ref, or a
// file artifact. Go module paths (example.com/foo) look url-ish but ARE the named
// module, so for go only a leading . / ~ disqualifies.
function isLocalOrUrl(t, ecosystem) {
  if (t.startsWith('.') || t.startsWith('/') || t.startsWith('~')) return true;
  if (ecosystem === 'go') return false; // a bare module path is the name; gate it
  if (t.includes('://')) return true;
  if (/^(?:git\+|file:|https?:|hg\+|svn\+|bzr\+)/.test(t)) return true;
  if (/\.(?:tgz|tar\.gz|whl|gz|zip|txt|toml|lock|cfg)$/.test(t)) return true;
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
function collectPackages(args, ecosystem) {
  const packages = [];
  for (let j = 0; j < args.length; j++) {
    const t = args[j];
    if (t.startsWith('-')) {
      if (VALUE_FLAGS.has(t)) j++; // consume its separate-token value
      continue;
    }
    const name = stripQuotes(t);
    if (!name || name === '&' || isLocalOrUrl(name, ecosystem)) continue;
    const bare = bareName(name);
    if (bare) packages.push(bare);
  }
  return packages;
}

// Detect a public-registry install that NAMES at least one package, in a single
// shell statement. Returns { ecosystem, packages: [names] } or null.
function detectSegment(stmt) {
  const toks = tokenize(stmt);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // env prefix
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
  const packages = collectPackages(args, ecosystem);
  if (packages.length === 0) return null; // lockfile/manifest install: nothing typed
  return { ecosystem, packages };
}

// Agents chain commands (`cd app && npm install foo`), so check every shell
// statement, not just the first. splitStatements is quote- and heredoc-aware, so
// a separator or install text inside quotes / a heredoc body is not a statement.
// Returns the first statement's hit, or null.
function detectInstall(cmd) {
  for (const stmt of splitStatements(cmd)) {
    const hit = detectSegment(stmt);
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
function evaluate(cmd) {
  try {
    if (isVerified(cmd)) return { kind: 'allow' }; // agent has vetted these
    const hit = detectInstall(cmd);
    if (hit) return blockVerdict(hit);
  } catch {
    // fall through to allow: a guard must never wedge the workflow
  }
  return { kind: 'allow' };
}

function run(data) {
  let cmd = '';
  try {
    cmd = (JSON.parse(data).tool_input || {}).command || '';
  } catch {
    process.exit(0); // unparseable input: nothing to gate
  }
  const v = evaluate(cmd);
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
