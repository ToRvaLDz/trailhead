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
// Only a NAMED install is gated: lockfile/manifest installs (bare `npm install`,
// `npm ci`, `pip install -r`, `cargo build`, `go mod download`, `bundle install`)
// and local paths / URLs / VCS refs carry no typed name and pass through.
// Blocks with exit 2 + {"decision":"block",...}; allows everything else.
// Crash-safe: any error → exit 0 (never wedge the user's workflow).
// Self-contained, no dependencies. Pure functions exported for tests; runs as a
// hook when executed directly.

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
]);

function basename(p) {
  const s = String(p).split('/');
  return s[s.length - 1];
}

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

// Detect a public-registry install that NAMES at least one package.
// Returns { ecosystem, packages: [names] } or null.
function detectInstall(cmd) {
  const toks = String(cmd).trim().split(/\s+/).filter(Boolean);
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

  const packages = [];
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.startsWith('-')) {
      if (VALUE_FLAGS.has(t)) j++; // consume its separate-token value
      continue;
    }
    if (isLocalOrUrl(t, ecosystem)) continue;
    packages.push(bareName(t));
  }
  if (packages.length === 0) return null; // lockfile/manifest install: nothing typed
  return { ecosystem, packages };
}

// The agent's "I have vetted these" acknowledgement.
function isVerified(cmd) {
  return SENTINEL.test(String(cmd));
}

function block(hit) {
  const list = hit.packages.join(', ');
  const reason =
    `trailhead: this ${hit.ecosystem} install names package(s) not yet vetted (${list}). ` +
    'Guard against slopsquatting before installing: verify each package is legitimate, weighing ' +
    'name / typosquat similarity to popular packages, package age / first-seen date, download counts / popularity, ' +
    'and repository metadata (present and matching). ' +
    'STOP and ask the human on anything suspicious (block-and-ask): do not install on your own judgement. ' +
    'Once vetted, re-run the exact command prefixed with `TRAILHEAD_VERIFIED_INSTALL=1` to proceed.';
  process.stdout.write(JSON.stringify({ decision: 'block', code: 'UNVETTED_PACKAGE_INSTALL', reason }));
  process.exit(2);
}

function run(data) {
  let cmd = '';
  try {
    cmd = (JSON.parse(data).tool_input || {}).command || '';
  } catch {
    process.exit(0); // unparseable input: nothing to gate
  }
  try {
    if (isVerified(cmd)) process.exit(0); // agent has vetted these
    const hit = detectInstall(cmd);
    if (hit) block(hit);
  } catch {
    // fall through to allow: a guard must never wedge the workflow
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

module.exports = { detectInstall, isVerified };
