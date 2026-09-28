'use strict';
// install-verify.js: post-install filesystem verification for both hosts.
//
// installClaude/installCodex place files and register hooks, but never
// checked any of it landed. This module adds that check: given a spec
// describing what an install is supposed to look like, it walks the
// filesystem (and the host's hook registry file) and reports what's missing
// or merely unverifiable (a registered hook target whose path depends on an
// env var this process doesn't have set).
//
// Reads the filesystem only, never writes, and never throws: a stat/parse
// error just counts as "missing" or an empty registry. It never reads
// process.env or os.homedir() itself; the caller always passes both in
// (spec.env, spec.home), so the tests stay hermetic.

const fs = require('fs');
const path = require('path');
const { codexLayout } = require('./codex-projection.js');

// --- fs probes, never throw --------------------------------------------------
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// --- sharedCoreFiles ----------------------------------------------------------
// The shared-core file list, single-sourced from _shared/load-first.md's own
// numbered "Load first, in order" list: load-first.md itself, plus every
// `../_shared/<name>.md` named on a numbered-list line, de-duplicated, in
// order. Empty/unreadable text still yields ['load-first.md'].
function sharedCoreFiles(loadFirstText) {
  const names = ['load-first.md'];
  const re = /^\d+\.\s+`\.\.\/_shared\/([\w.-]+\.md)`/gm;
  let m;
  while ((m = re.exec(loadFirstText || '')) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// --- hookScriptTokens ---------------------------------------------------------
// Split a shell-like command into tokens (quotes stripped), then return every
// token whose basename matches trailhead-<name>.js. A1: a quoted token that
// itself contains whitespace (e.g. bash -c's payload) is re-tokenized
// recursively, so an inner script path nested inside `bash -c '...'` is still
// found as its own token.
function tokenize(command) {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const tokens = [];
  let m;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return tokens;
}

function hookScriptTokens(command) {
  const found = [];
  const visit = (cmd) => {
    for (const token of tokenize(cmd)) {
      if (/\s/.test(token)) {
        visit(token);
      } else if (/^trailhead-[\w-]+\.js$/.test(path.basename(token))) {
        found.push(token);
      }
    }
  };
  visit(command || '');
  return found;
}

// --- expandTarget --------------------------------------------------------------
// Expand a `~`/`~/...` prefix (to `home`) and any `$VAR`/`${VAR}` references
// (from `env`). The first undefined variable short-circuits to
// { unresolved: varName }; an empty-string value counts as defined and is
// substituted as-is. `~user/...` is intentionally NOT expanded (it stays
// relative and later fails as a relative target).
function expandTarget(token, { env, home }) {
  let result = token;
  if (result === '~' || result.startsWith('~/')) {
    result = path.join(home, result.slice(1));
  }
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = '';
  let lastIndex = 0;
  let match;
  while ((match = re.exec(result)) !== null) {
    const name = match[1] || match[2];
    const val = env[name];
    if (val === undefined) return { unresolved: name };
    out += result.slice(lastIndex, match.index) + val;
    lastIndex = match.index + match[0].length;
  }
  out += result.slice(lastIndex);
  return { path: out };
}

// --- verifyInstall: individual checks -----------------------------------------
function checkSkills(spec, missing) {
  for (const name of spec.skillDirs) {
    if (name === '_shared') continue;
    const skillMd = path.join(spec.skillsRoot, name, 'SKILL.md');
    if (!isDir(path.join(spec.skillsRoot, name)) || !isFile(skillMd)) {
      missing.push(`skill ${name}/SKILL.md`);
    }
  }
}

function checkSharedCore(spec, missing) {
  const sharedDir = path.join(spec.skillsRoot, '_shared');
  for (const f of spec.sharedFiles) {
    if (!isDir(sharedDir) || !isFile(path.join(sharedDir, f))) missing.push(`shared core _shared/${f}`);
  }
}

function checkHookScripts(spec, missing) {
  for (const f of spec.hookFiles) {
    if (!isFile(path.join(spec.hooksDir, f))) missing.push(`hook script ${f}`);
  }
  for (const f of spec.hookLibFiles) {
    if (!isFile(path.join(spec.hooksDir, 'lib', f))) missing.push(`hook lib lib/${f}`);
  }
}

function readRegistry(registryFile) {
  try { return JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { return {}; }
}

// Registered hook targets + expected registration. Walks hooks.<event>[].hooks[]
// .command in the registry file, expands each trailhead-* token, and sorts it
// into `missing` (relative or non-existent) or `unverified` (undefined var).
// Then, per A2, an expected hookFiles entry counts as registered when some
// token expands to exactly hooksDir/<f>, OR an unresolved token's basename is
// <f> (stays warning-only, never also missing).
function checkRegisteredTargets(spec, missing, unverified) {
  const registry = readRegistry(spec.registryFile);
  const registryName = path.basename(spec.registryFile);
  const events = (registry && typeof registry.hooks === 'object' && registry.hooks) ? registry.hooks : {};
  const registeredExact = new Set();
  const registeredViaUnresolved = new Set();

  for (const [event, groups] of Object.entries(events)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
        const command = typeof hook.command === 'string' ? hook.command : '';
        for (const token of hookScriptTokens(command)) {
          const expanded = expandTarget(token, { env: spec.env, home: spec.home });
          if (expanded.unresolved) {
            unverified.push(`${token} (${event}, ${registryName}: $${expanded.unresolved} undefined)`);
            registeredViaUnresolved.add(path.basename(token));
            continue;
          }
          if (!path.isAbsolute(expanded.path)) {
            missing.push(`registered hook target ${token} is relative (${event}, ${registryName})`);
            continue;
          }
          if (!isFile(expanded.path)) {
            missing.push(`registered hook target ${expanded.path} (${event}, ${registryName})`);
            continue;
          }
          for (const f of spec.hookFiles) {
            if (expanded.path === path.join(spec.hooksDir, f)) registeredExact.add(f);
          }
        }
      }
    }
  }

  for (const f of spec.hookFiles) {
    if (!registeredExact.has(f) && !registeredViaUnresolved.has(f)) {
      missing.push(`hook registration ${f} (${registryName})`);
    }
  }
}

function checkAgents(spec, missing) {
  let files = [];
  if (isDir(spec.agentsDir)) {
    try { files = fs.readdirSync(spec.agentsDir); } catch { files = []; }
  }
  const hasMatch = files.some((f) => spec.agentPattern.test(f) && isFile(path.join(spec.agentsDir, f)));
  if (!hasMatch) missing.push(`agents: no trailhead-* agents in ${spec.agentsDir}`);
}

// --- verifyInstall --------------------------------------------------------------
// spec = { skillsRoot, skillDirs, sharedFiles, hooksDir, hookFiles,
//          hookLibFiles, registryFile, agentsDir, agentPattern, env, home }
function verifyInstall(spec) {
  const missing = [];
  const unverified = [];
  checkSkills(spec, missing);
  checkSharedCore(spec, missing);
  checkHookScripts(spec, missing);
  checkRegisteredTargets(spec, missing, unverified);
  checkAgents(spec, missing);
  return { missing, unverified };
}

// --- spec builders ---------------------------------------------------------
function claudeVerifySpec(configDir, { skillDirs, sharedFiles, hookFiles, hookLibFiles, env, home }) {
  return {
    skillsRoot: path.join(configDir, 'skills'),
    skillDirs,
    sharedFiles,
    hooksDir: path.join(configDir, 'hooks'),
    hookFiles,
    hookLibFiles,
    registryFile: path.join(configDir, 'settings.json'),
    agentsDir: path.join(configDir, 'agents'),
    agentPattern: /^trailhead-.*\.md$/,
    env,
    home,
  };
}

function codexVerifySpec(configDir, { skillDirs, sharedFiles, hookFiles, hookLibFiles, env, home }) {
  const L = codexLayout(configDir);
  return {
    skillsRoot: L.skillsRoot,
    skillDirs,
    sharedFiles,
    hooksDir: L.hooksScriptsDir,
    hookFiles,
    hookLibFiles,
    registryFile: L.hooksJson,
    agentsDir: L.codexAgentsDir,
    agentPattern: /^trailhead-.*\.toml$/,
    env,
    home,
  };
}

// --- formatters --------------------------------------------------------------
function formatVerifyFailure(hostLabel, configDir, { missing, unverified }) {
  const lines = [`✗ trailhead install incomplete for ${hostLabel} → ${configDir}`];
  for (const m of missing) lines.push(`  missing: ${m}`);
  for (const u of unverified) lines.push(`  unverified: ${u}`);
  lines.push('Re-run the installer to restore a missing file. For a stale or relative hook target, remove that entry from the registry file named above (or run --uninstall), then reinstall.');
  return lines.join('\n');
}

function formatVerifyWarnings(unverified) {
  return unverified.map((u) => `  ⚠ unverified hook target ${u}`);
}

module.exports = {
  sharedCoreFiles,
  hookScriptTokens,
  expandTarget,
  verifyInstall,
  claudeVerifySpec,
  codexVerifySpec,
  formatVerifyFailure,
  formatVerifyWarnings,
};
