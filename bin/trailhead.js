#!/usr/bin/env node
'use strict';
// trailhead installer: places the skill, commands, hooks, and templates into
// an agent's config dir, and registers the hooks in settings.json.
// No dependencies. Idempotent. Usage:
//   npx @marcomigozzi/trailhead                install (auto-detects the CLI on your PATH; asks if it can't tell)
//   npx @marcomigozzi/trailhead --claude       force install for Claude Code (~/.claude or $CLAUDE_CONFIG_DIR)
//   npx @marcomigozzi/trailhead --codex        force install for Codex ($CODEX_HOME or ~/.codex)
//   npx @marcomigozzi/trailhead --symlink      dev install (symlink to the package, live edits; Claude only)
//   npx @marcomigozzi/trailhead --uninstall
//   npx @marcomigozzi/trailhead --dir=/path/to/configdir
//
// Multi-host: host layout/behaviour comes from bin/lib/host-descriptor.js
// (the descriptor table for claude/codex) and, for Codex, the artifact
// projection in bin/lib/codex-projection.js (engine text rewrites, prompt
// generation). With no --codex/--claude flag the host is auto-detected from
// the CLIs on $PATH; the interactive prompt only fires when that is ambiguous.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const { getHost, configDirFor, codexVersionGate } = require('./lib/host-descriptor.js');
const { codexLayout, convertToCodex, injectCodexAdapterHeader, codexAgentsYaml, codexHookEntries, enableCodexHooksFeature, codexAgentTomlPlan, enableCodexMultiAgentV2Feature } = require('./lib/codex-projection.js');

const PKG = path.resolve(__dirname, '..');
const SRC = path.join(PKG, 'plugins', 'trailhead');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const useSymlink = has('--symlink');
const uninstall = has('--uninstall');
const dirArg = (args.find((a) => a.startsWith('--dir=')) || '').split('=')[1];

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const ensure = (p) => fs.mkdirSync(p, { recursive: true });
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const writeJSON = (p, o) => { ensure(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };

// --- readCodexModels ---------------------------------------------------------
// Resolve the merged models.codex.* config for the Codex agent-TOML projection:
// the project-local .trailhead/config.json (found by walking up from cwd, capped
// at 8 levels) overlaid on the Codex-side global at <codexHome>/trailhead/config.json,
// project winning per key. Never throws: any missing/malformed file just
// contributes nothing.
function findProjectConfig(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.trailhead', 'config.json');
    if (fs.existsSync(candidate)) return readJSON(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

function readCodexModels(codexHome) {
  try {
    const projectCfg = findProjectConfig(process.cwd()) || {};
    const globalCfg = readJSON(path.join(codexHome, 'trailhead', 'config.json')) || {};
    const globalCodex = globalCfg.models && typeof globalCfg.models === 'object' && typeof globalCfg.models.codex === 'object' && globalCfg.models.codex ? globalCfg.models.codex : {};
    const projectCodex = projectCfg.models && typeof projectCfg.models === 'object' && typeof projectCfg.models.codex === 'object' && projectCfg.models.codex ? projectCfg.models.codex : {};
    return { ...globalCodex, ...projectCodex };
  } catch {
    return {};
  }
}

// --- host resolution -------------------------------------------------------
// Explicit --codex / --claude win outright. With neither, the host is
// auto-detected from the CLIs on $PATH: exactly one found -> install for it,
// no question; ambiguous (none, or several) on an interactive TTY -> ask; an
// ambiguous non-interactive run (npx/CI, or --dir=) falls back to claude so
// scripted installs never hang on a prompt nobody can answer.
const KNOWN_HOSTS = ['claude', 'codex']; // preference order for the fallback; mirrors host-descriptor HOSTS

// True if an executable named `bin` sits in one of $PATH's directories. No
// child process: we just probe each PATH entry for an executable file.
function isOnPath(bin, env = process.env) {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch { /* not here, keep looking */ }
  }
  return false;
}

function detectInstalledHosts(env = process.env) {
  return KNOWN_HOSTS.filter((name) => isOnPath(name, env));
}

function promptForHost(detected = []) {
  const mark = (name) => (detected.includes(name) ? '  (detected)' : '');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      'Install trailhead for which host?\n' +
        `  1) Claude Code${mark('claude')} (default)\n` +
        `  2) Codex${mark('codex')}\n> `,
      (answer) => {
        rl.close();
        const choice = String(answer).trim().toLowerCase();
        resolve(choice === '2' || choice === 'codex' ? 'codex' : 'claude');
      }
    );
  });
}

async function resolveHostName() {
  const wantCodex = has('--codex');
  const wantClaude = has('--claude');
  if (wantCodex && wantClaude) {
    console.error('Pass only one of --codex or --claude.');
    process.exit(1);
  }
  if (wantCodex) return 'codex';
  if (wantClaude) return 'claude';

  // No explicit flag: auto-detect from the CLIs on $PATH.
  const detected = detectInstalledHosts();
  if (detected.length === 1) {
    console.log(`Detected ${getHost(detected[0]).label} on your PATH; installing for it.`);
    return detected[0];
  }
  // --dir= alone signals scripted/automation usage (tests, CI harnesses), even
  // when stdin happens to be a TTY, so it never triggers the prompt. Ambiguous
  // (0 or 2+ CLIs) + interactive -> ask; otherwise fall back to claude.
  if (process.stdin.isTTY && !dirArg) {
    return promptForHost(detected);
  }
  return 'claude';
}

// --- Claude adapter (unchanged behaviour) -----------------------------------
function claudePaths(configDir) {
  return {
    skill: path.join(configDir, 'skills', 'trailhead'),
    commands: path.join(configDir, 'commands', 'trailhead'),
    hooksDir: path.join(configDir, 'hooks'),
    templates: path.join(configDir, 'trailhead', 'templates'),
    settings: path.join(configDir, 'settings.json'),
  };
}
const HOOK_FILES = ['trailhead-commit-guard.js', 'trailhead-issue-injection-scanner.js', 'trailhead-secret-guard.js', 'trailhead-check-update.js'];

function place(src, dest, symlink) {
  rmrf(dest);
  ensure(path.dirname(dest));
  if (symlink) fs.symlinkSync(src, dest, 'dir');
  else fs.cpSync(src, dest, { recursive: true });
}

function addHook(s, event, matcher, command) {
  s.hooks = s.hooks || {};
  s.hooks[event] = s.hooks[event] || [];
  const present = s.hooks[event].some((g) => (g.hooks || []).some((h) => (h.command || '').includes(command)));
  if (present) return false;
  let group = s.hooks[event].find((g) => g.matcher === matcher);
  if (!group) { group = { matcher, hooks: [] }; s.hooks[event].push(group); }
  group.hooks.push({ type: 'command', command });
  return true;
}
function stripHook(s, event, substr) {
  if (!s.hooks || !s.hooks[event]) return;
  for (const g of s.hooks[event]) g.hooks = (g.hooks || []).filter((h) => !(h.command || '').includes(substr));
  s.hooks[event] = s.hooks[event].filter((g) => (g.hooks || []).length);
}

function uninstallClaude(configDir) {
  const P = claudePaths(configDir);
  [P.skill, P.commands, path.join(configDir, 'trailhead')].forEach(rmrf);
  HOOK_FILES.forEach((f) => rmrf(path.join(P.hooksDir, f)));
  const s = readJSON(P.settings);
  stripHook(s, 'PreToolUse', 'trailhead-commit-guard.js');
  stripHook(s, 'PreToolUse', 'trailhead-secret-guard.js');
  stripHook(s, 'PostToolUse', 'trailhead-issue-injection-scanner.js');
  stripHook(s, 'SessionStart', 'trailhead-check-update.js');
  writeJSON(P.settings, s);
  console.log(`trailhead uninstalled from ${configDir}`);
}

function installClaude(configDir, { useSymlink }) {
  const P = claudePaths(configDir);
  const hookCmd = (name) => `node "${path.join(P.hooksDir, name)}"`;

  place(path.join(SRC, 'skills', 'trailhead'), P.skill, useSymlink);
  place(path.join(SRC, 'commands'), P.commands, useSymlink);
  place(path.join(SRC, 'templates'), P.templates, useSymlink);
  ensure(P.hooksDir);
  for (const f of HOOK_FILES) {
    fs.copyFileSync(path.join(SRC, 'hooks', f), path.join(P.hooksDir, f));
    fs.chmodSync(path.join(P.hooksDir, f), 0o755);
  }
  // version marker: serve al check-update hook per la versione installata (canale npm)
  const pkgVersion = (readJSON(path.join(SRC, '.claude-plugin', 'plugin.json')).version || '').trim();
  if (pkgVersion) {
    ensure(path.join(configDir, 'trailhead'));
    fs.writeFileSync(path.join(configDir, 'trailhead', 'VERSION'), pkgVersion + '\n');
  }

  const s = readJSON(P.settings);
  const added = [
    addHook(s, 'PreToolUse', 'Bash', hookCmd('trailhead-commit-guard.js')),
    addHook(s, 'PreToolUse', 'Bash', hookCmd('trailhead-secret-guard.js')),
    addHook(s, 'PostToolUse', 'Bash', hookCmd('trailhead-issue-injection-scanner.js')),
    addHook(s, 'SessionStart', '', hookCmd('trailhead-check-update.js')),
  ].some(Boolean);
  writeJSON(P.settings, s);

  console.log(`✓ trailhead installed for Claude Code → ${configDir}`);
  console.log(`  skill     → ${P.skill}${useSymlink ? '  (symlink)' : ''}`);
  console.log(`  commands  → ${P.commands}  (/trailhead:*)`);
  console.log(`  hooks     → ${P.hooksDir}/  (${added ? 'registered' : 'already present'} in settings.json)`);
  console.log(`  templates → ${P.templates}`);
  console.log('\nRestart or reload your agent to pick up the commands, then run /trailhead to start.');
  console.log('Note: the commit guard now runs on every git commit (conventional + no Co-Authored-By).');
}

// --- Codex adapter -----------------------------------------------------------
// Codex has a native subagent toolkit (the multi_agent tools, on by default at
// the floor). trailhead installs as one native Codex skill under
// skills/trailhead/: the engine text is projected with convertToCodex +
// codexSkillAdapterHeader, and agents/openai.yaml (codexAgentsYaml) registers
// it for explicit-only `$trailhead <verb>` invocation.
// Base multi_agent fan-out needs no manifest, but when models.codex.* is set
// per technique, the installer projects those pins into per-technique
// trailhead-<technique>.toml files under the real ~/.codex/agents/ dir
// (codexAgentTomlPlan) and enables features.multi_agent_v2 so Codex honours
// them; with no models.codex.* set, subagents still inherit the session model.

// Recursively copy plugins/trailhead/skills/trailhead into destDir, applying
// convertToCodex to every .md file (and prepending the adapter header to the
// top-level SKILL.md). Mirrors the source tree shape (references/, references/techniques/, ...).
function copySkillConverted(srcDir, destDir, isRoot) {
  ensure(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copySkillConverted(srcPath, destPath, false);
    } else if (entry.name.endsWith('.md')) {
      const raw = fs.readFileSync(srcPath, 'utf8');
      let converted = convertToCodex(raw);
      if (isRoot && entry.name === 'SKILL.md') {
        // Inject the adapter header AFTER the YAML frontmatter so the
        // frontmatter stays at the top and Codex registers the skill (#40).
        converted = injectCodexAdapterHeader(converted);
      }
      fs.writeFileSync(destPath, converted);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Best-effort `codex --version` probe for the install-time floor gate. Returns
// the raw version string, or null when codex is not on PATH / errors out.
function detectCodexVersion() {
  try {
    const r = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || r.stderr || '').trim() || null;
  } catch {
    return null;
  }
}

function installCodex(configDir, { useSymlink }) {
  // Floor gate (decision #27): refuse to project onto a Codex below the
  // multi_agent floor; warn (but proceed) when the version can't be read.
  const gate = codexVersionGate(detectCodexVersion());
  if (!gate.proceed) {
    console.error(`✗ ${gate.message}`);
    process.exitCode = 1;
    return;
  }
  if (gate.undetermined) console.warn(`⚠ ${gate.message}`);

  const L = codexLayout(configDir);

  if (useSymlink) {
    console.log('Note: symlink install is unavailable for Codex (artifacts are generated, not copied verbatim); installing copies instead.');
  }

  // Migration: sweep the pre-#25 layout (prompts/trailhead*.md + the trailhead/ engine dir).
  rmrf(path.join(L.legacyPromptsDir, 'trailhead.md'));
  for (const f of (fs.existsSync(L.legacyPromptsDir) ? fs.readdirSync(L.legacyPromptsDir) : [])) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.legacyPromptsDir, f));
  }
  rmrf(L.legacyEngineDir);

  // Engine: clean skill dir, then project with conversion.
  rmrf(L.skillDir);
  ensure(L.skillDir);
  copySkillConverted(path.join(SRC, 'skills', 'trailhead'), L.skillDir, true);

  // Templates (verbatim, never converted), bundled inside the skill dir so
  // ${CLAUDE_PLUGIN_ROOT}/templates resolves to ~/.codex/skills/trailhead/templates.
  ensure(L.templatesDir);
  fs.cpSync(path.join(SRC, 'templates'), L.templatesDir, { recursive: true });

  // agents/openai.yaml: UI metadata + explicit-only invocation (no auto-trigger).
  ensure(L.agentsDir);
  fs.writeFileSync(L.agentsYaml, codexAgentsYaml());

  const pkgVersion = (readJSON(path.join(SRC, '.claude-plugin', 'plugin.json')).version || '').trim();
  if (pkgVersion) fs.writeFileSync(L.versionFile, pkgVersion + '\n');

  // Hooks: copy the 4 guard scripts into the skill dir and register them in
  // ~/.codex/hooks.json (same shape as Claude's settings.json hooks block).
  ensure(L.hooksScriptsDir);
  for (const f of HOOK_FILES) {
    const dest = path.join(L.hooksScriptsDir, f);
    fs.copyFileSync(path.join(SRC, 'hooks', f), dest);
    fs.chmodSync(dest, 0o755);
  }
  const h = readJSON(L.hooksJson);
  for (const e of codexHookEntries(L.hooksScriptsDir)) addHook(h, e.event, e.matcher, e.command);
  writeJSON(L.hooksJson, h);

  // Feature flag: Codex gates the hook bus behind features.hooks = true.
  let current = '';
  try { current = fs.readFileSync(L.configToml, 'utf8'); } catch { current = ''; }
  const updatedToml = enableCodexHooksFeature(current);
  let featureManual = false;
  if (updatedToml && typeof updatedToml === 'string') {
    ensure(path.dirname(L.configToml));
    fs.writeFileSync(L.configToml, updatedToml);
    current = updatedToml;
  } else if (updatedToml && updatedToml.unsafe) {
    featureManual = true;
  }

  // Per-technique model pins: project models.codex.* (merged project + global
  // config) into trailhead-<technique>.toml under the real ~/.codex/agents/
  // dir. Sweep only trailhead's own files first, so a stale pin from a prior
  // install (or a removed technique) never lingers, without touching the
  // user's other custom-agent TOMLs.
  const codexModels = readCodexModels(configDir);
  ensure(L.codexAgentsDir);
  for (const f of fs.readdirSync(L.codexAgentsDir)) {
    if (/^trailhead-.*\.toml$/.test(f)) rmrf(path.join(L.codexAgentsDir, f));
  }
  const plan = codexAgentTomlPlan(configDir, codexModels);
  for (const w of plan.writes) fs.writeFileSync(w.path, w.content);

  // Feature flag: Codex gates per-subagent model pinning behind
  // features.multi_agent_v2 = true. Enable it ONLY when we actually projected
  // pins: with no models.codex.* set, base multi_agent already fans out and the
  // adapter's §D runtime detection expects no trailhead agent_type registry, so
  // leaving v2 off keeps that contract sound. (A reinstall that drops all pins
  // sweeps the TOMLs above but leaves any prior v2 flag in place; harmless, as
  // no trailhead-* agents remain for the runtime to dispatch to.)
  let featureManualV2 = false;
  if (plan.writes.length > 0) {
    const updatedTomlV2 = enableCodexMultiAgentV2Feature(current);
    if (updatedTomlV2 && typeof updatedTomlV2 === 'string') {
      ensure(path.dirname(L.configToml));
      fs.writeFileSync(L.configToml, updatedTomlV2);
    } else if (updatedTomlV2 && updatedTomlV2.unsafe) {
      featureManualV2 = true;
    }
  }

  console.log(`✓ trailhead installed for Codex → ${configDir}`);
  console.log(`  skill     → ${L.skillDir}/  (invoke $trailhead)`);
  console.log(`  templates → ${L.templatesDir}/`);
  console.log(`  hooks     → ${L.hooksScriptsDir}/  (registered in hooks.json)`);
  if (plan.writes.length > 0) {
    console.log(`  agents    → ${L.codexAgentsDir}/  (${plan.writes.length} model pin(s): ${plan.writes.map((w) => w.name + '.toml').join(', ')})`);
  } else {
    console.log('  agents    → no models.codex.* set, subagents inherit the session model');
  }
  console.log('\nRestart or reload Codex to pick up the skill, then run $trailhead to start.');
  // The trust prompt only fires once the feature flag is on. When we could not
  // edit config.toml, the hooks stay inert until the user sets it by hand, so
  // don't reassure them about a trust review that won't happen yet.
  if (featureManual) {
    console.log(`  ⚠ could not edit ${L.configToml} automatically — add \`features.hooks = true\` under [features] by hand, then Codex will ask you to trust trailhead's hooks on next start.`);
  } else {
    console.log('Note: Codex will ask you to trust trailhead\'s hooks on next start (feature `features.hooks`).');
  }
  if (featureManualV2) {
    console.log(`  ⚠ could not edit ${L.configToml} automatically, add \`features.multi_agent_v2 = true\` under [features] by hand to let Codex honour the projected model pins.`);
  }
}

function uninstallCodex(configDir) {
  const L = codexLayout(configDir);
  rmrf(L.skillDir);
  // sweep any pre-#25 layout too
  rmrf(path.join(L.legacyPromptsDir, 'trailhead.md'));
  for (const f of (fs.existsSync(L.legacyPromptsDir) ? fs.readdirSync(L.legacyPromptsDir) : [])) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.legacyPromptsDir, f));
  }
  rmrf(L.legacyEngineDir);
  // Sweep trailhead's own per-technique model-pin TOMLs, never the user's
  // other custom-agent TOMLs in the same dir.
  if (fs.existsSync(L.codexAgentsDir)) {
    for (const f of fs.readdirSync(L.codexAgentsDir)) {
      if (/^trailhead-.*\.toml$/.test(f)) rmrf(path.join(L.codexAgentsDir, f));
    }
  }
  // Strip trailhead's entries from hooks.json, but only if it already exists
  // (uninstall must never create it). Leave features.hooks and
  // features.multi_agent_v2 in config.toml untouched: the user may rely on
  // them for other hooks/agents, mirroring how uninstallClaude leaves
  // settings.json flags alone.
  if (fs.existsSync(L.hooksJson)) {
    const h = readJSON(L.hooksJson);
    stripHook(h, 'PreToolUse', 'trailhead-commit-guard.js');
    stripHook(h, 'PreToolUse', 'trailhead-secret-guard.js');
    stripHook(h, 'PostToolUse', 'trailhead-issue-injection-scanner.js');
    stripHook(h, 'SessionStart', 'trailhead-check-update.js');
    writeJSON(L.hooksJson, h);
  }
  console.log(`trailhead uninstalled from ${configDir}`);
}

// --- main --------------------------------------------------------------------
async function main() {
  const host = await resolveHostName();
  const configDir = dirArg || configDirFor(host);

  if (uninstall) {
    if (host === 'codex') uninstallCodex(configDir);
    else uninstallClaude(configDir);
    return;
  }

  if (host === 'codex') installCodex(configDir, { useSymlink });
  else installClaude(configDir, { useSymlink });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
