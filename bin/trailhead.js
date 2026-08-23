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
const { codexLayout, convertToCodex, injectCodexAdapterHeader, codexAgentsYaml, codexClusterAgentsYaml, codexHookEntries, enableCodexHooksFeature, codexAgentTomlPlan, codexVerbSkillPlan, enableCodexMultiAgentV2Feature } = require('./lib/codex-projection.js');

const PKG = path.resolve(__dirname, '..');
const SRC = path.join(PKG, 'plugins', 'trailhead');

// Enumerate the engine skill dirs shipped under plugins/trailhead/skills: the
// dispatcher, the cluster skills, and the shared core. A subdir qualifies when
// it is `_shared` (the shared core, no SKILL.md) or contains a SKILL.md, so a
// stray empty dir is skipped and a new cluster is picked up automatically.
function engineSkillDirs() {
  const skillsRoot = path.join(SRC, 'skills');
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name === '_shared' || fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();
}

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
    commands: path.join(configDir, 'commands', 'trailhead'),
    hooksDir: path.join(configDir, 'hooks'),
    templates: path.join(configDir, 'trailhead', 'templates'),
    settings: path.join(configDir, 'settings.json'),
  };
}
const HOOK_FILES = ['trailhead-commit-guard.js', 'trailhead-issue-injection-scanner.js', 'trailhead-secret-guard.js', 'trailhead-check-update.js'];
// Runtime libs the hook scripts require (trailhead-commit-guard.js does
// require('./lib/commit-message-check.js')). Copied by name, never a recursive
// sweep: the Claude hooks/lib dir is shared with other plugins, so we must not
// clobber a co-tenant's lib nor ship our own *.test.js files.
const HOOK_LIB_FILES = ['commit-message-check.js'];

// Copy the hook scripts and their runtime libs into a destination hooks dir
// (Claude's ~/.claude/hooks or Codex's skills/trailhead/hooks). Shared by both
// install paths so the lib copy can never drift from the script copy again.
function copyHookScripts(destHooksDir) {
  ensure(destHooksDir);
  for (const f of HOOK_FILES) {
    fs.copyFileSync(path.join(SRC, 'hooks', f), path.join(destHooksDir, f));
    fs.chmodSync(path.join(destHooksDir, f), 0o755);
  }
  if (HOOK_LIB_FILES.length) {
    const libDest = path.join(destHooksDir, 'lib');
    ensure(libDest);
    for (const f of HOOK_LIB_FILES) {
      fs.copyFileSync(path.join(SRC, 'hooks', 'lib', f), path.join(libDest, f));
    }
  }
}

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
  for (const name of engineSkillDirs()) rmrf(path.join(configDir, 'skills', name));
  [P.commands, path.join(configDir, 'trailhead')].forEach(rmrf);
  HOOK_FILES.forEach((f) => rmrf(path.join(P.hooksDir, f)));
  // Remove only trailhead's own lib files by name: the hooks/lib dir is shared
  // with other plugins, so never rmrf the whole dir.
  HOOK_LIB_FILES.forEach((f) => rmrf(path.join(P.hooksDir, 'lib', f)));
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

  // Place each engine skill dir as a sibling under configDir/skills so the
  // ../_shared/ and ../trailhead-<cluster>/ relative refs resolve. The skills
  // dir is shared with other plugins: place by name, never touch the whole dir.
  const skillDirs = engineSkillDirs();
  for (const name of skillDirs) {
    place(path.join(SRC, 'skills', name), path.join(configDir, 'skills', name), useSymlink);
  }
  place(path.join(SRC, 'commands'), P.commands, useSymlink);
  place(path.join(SRC, 'templates'), P.templates, useSymlink);
  copyHookScripts(P.hooksDir);
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
  console.log(`  skills    → ${path.join(configDir, 'skills')}/  (${skillDirs.join(', ')})${useSymlink ? '  (symlink)' : ''}`);
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

// Read the canonical command surface from plugins/trailhead/commands/*.md:
// each file's basename is the verb; its frontmatter description/argument-hint
// (when present) ride along as the Codex prompt shim's discoverability metadata.
// Single-sources the verb list so the Codex shims never drift from the commands.
function readCommandVerbs() {
  const dir = path.join(SRC, 'commands');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      return { verb: f.slice(0, -3), description: fmValue(raw, 'description'), argumentHint: fmValue(raw, 'argument-hint') };
    })
    .sort((a, b) => a.verb.localeCompare(b.verb));
}

// Extract one frontmatter scalar's raw value verbatim (an already-valid YAML
// scalar re-serialises unchanged). Looks only inside the leading ---...--- block.
// Returns undefined when the key is absent or its value is empty.
function fmValue(md, key) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const block = fm ? fm[1] : '';
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block);
  if (!m) return undefined;
  const v = m[1].trim();
  return v === '' ? undefined : v;
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

  // Migration: sweep the pre-#25 layout AND the #42 prompt shims that never
  // surfaced as Codex slash commands (#46): prompts/trailhead*.md + the
  // trailhead/ engine dir. Removing them on every (re)install cleans up an
  // upgrade from the shim layout.
  rmrf(path.join(L.promptsDir, 'trailhead.md'));
  for (const f of (fs.existsSync(L.promptsDir) ? fs.readdirSync(L.promptsDir) : [])) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.promptsDir, f));
  }
  rmrf(L.legacyEngineDir);

  // Sweep the whole engine + any prior per-verb skills, then project fresh.
  rmrf(L.skillDir);                                   // skills/trailhead (dispatcher)
  rmrf(path.join(L.skillsRoot, '_shared'));           // shared core
  for (const f of (fs.existsSync(L.skillsRoot) ? fs.readdirSync(L.skillsRoot) : [])) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.skillsRoot, f)); // clusters + old verb skills
  }

  // Project each engine skill dir (dispatcher + 5 clusters + _shared) as a
  // sibling under skills/, converting text and injecting the adapter header into
  // each top-level SKILL.md. The ../_shared/ relative refs survive conversion and
  // resolve as siblings (decision #54). _shared has no SKILL.md, so no header.
  const engineDirs = engineSkillDirs();
  for (const name of engineDirs) {
    copySkillConverted(path.join(SRC, 'skills', name), path.join(L.skillsRoot, name), true);
  }

  // Templates (verbatim, never converted), bundled inside the skill dir so
  // ${CLAUDE_PLUGIN_ROOT}/templates resolves to ~/.codex/skills/trailhead/templates.
  ensure(L.templatesDir);
  fs.cpSync(path.join(SRC, 'templates'), L.templatesDir, { recursive: true });

  // agents/openai.yaml: UI metadata + explicit-only invocation (no auto-trigger).
  ensure(L.agentsDir);
  fs.writeFileSync(L.agentsYaml, codexAgentsYaml());
  // Each cluster skill also gets explicit-only UI metadata (never auto-invoked).
  for (const name of engineDirs) {
    if (name === 'trailhead' || name === '_shared') continue;
    const dir = path.join(L.skillsRoot, name, 'agents');
    ensure(dir);
    fs.writeFileSync(path.join(dir, 'openai.yaml'), codexClusterAgentsYaml(name));
  }

  // Per-verb discoverability (#46): one thin Codex skill per verb
  // (skills/trailhead-<verb>/, invocable as $trailhead-<verb>), each delegating
  // to $trailhead <verb>. Codex custom prompts (~/.codex/prompts/) never surface
  // as slash commands, so per-verb skills carry the surface, exactly as GSD does.
  // Verbs come from the canonical commands/*.md so the surfaces never drift.
  // Skip any verb whose skill dir would collide with a projected cluster skill
  // (e.g. verb `work` vs the trailhead-work cluster): the cluster skill is its
  // own $trailhead-<name> entry. Compute the skip-set from the projected dirs.
  const clusterDirNames = new Set(engineDirs);
  const verbList = readCommandVerbs().filter((c) => !clusterDirNames.has(`trailhead-${c.verb}`));
  const verbSkillPlan = codexVerbSkillPlan(configDir, verbList);
  for (const d of verbSkillPlan.dirs) ensure(path.join(d, 'agents'));
  for (const w of verbSkillPlan.writes) fs.writeFileSync(w.path, w.content);

  const pkgVersion = (readJSON(path.join(SRC, '.claude-plugin', 'plugin.json')).version || '').trim();
  if (pkgVersion) fs.writeFileSync(L.versionFile, pkgVersion + '\n');

  // Hooks: copy the 4 guard scripts into the skill dir and register them in
  // ~/.codex/hooks.json (same shape as Claude's settings.json hooks block).
  copyHookScripts(L.hooksScriptsDir);
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
  console.log(`  verb skills → ${L.skillsRoot}/trailhead-<verb>/  (${verbSkillPlan.dirs.length} discoverability skills: invoke $trailhead-<verb>)`);
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
    console.log(`  ⚠ could not edit ${L.configToml} automatically; add \`features.hooks = true\` under [features] by hand, then Codex will ask you to trust trailhead's hooks on next start.`);
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
  rmrf(path.join(L.skillsRoot, '_shared'));
  // sweep the per-verb discoverability skills (skills/trailhead-<verb>/, #46),
  // never the main skills/trailhead (already removed above; does not match).
  for (const f of (fs.existsSync(L.skillsRoot) ? fs.readdirSync(L.skillsRoot) : [])) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.skillsRoot, f));
  }
  // sweep any pre-#25 layout AND the #42 prompt shims from prompts/
  rmrf(path.join(L.promptsDir, 'trailhead.md'));
  for (const f of (fs.existsSync(L.promptsDir) ? fs.readdirSync(L.promptsDir) : [])) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.promptsDir, f));
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
