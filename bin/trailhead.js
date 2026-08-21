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

const { getHost, configDirFor, hyphenateCommand } = require('./lib/host-descriptor.js');
const { codexLayout, convertToCodex, codexSkillAdapterHeader, codexPromptFor } = require('./lib/codex-projection.js');

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
// Codex has no Skill tool, no subagent toolkit, and no hook bus (see
// host-descriptor.js degradations()). The engine text itself is projected
// with convertToCodex + codexSkillAdapterHeader; the commands become flat
// hyphenated prompt files via codexPromptFor. No agents/ dir (emitsAgentToml
// is false for codex) and no hooks/settings.json touched.

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
        converted = codexSkillAdapterHeader() + '\n\n' + converted;
      }
      fs.writeFileSync(destPath, converted);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Parse the simple `key: value` frontmatter lines a command file uses (only
// description and argument-hint matter for a Codex prompt).
function parseCommandFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  const head = match ? match[1] : '';
  const descMatch = head.match(/^description:\s*(.*)$/m);
  const hintMatch = head.match(/^argument-hint:\s*(.*)$/m);
  const description = descMatch ? descMatch[1].trim() : '';
  let argHint = hintMatch ? hintMatch[1].trim() : '';
  // Strip a wrapping pair of quotes ("" or non-empty "...") the source files use.
  if (argHint === '""' || argHint === "''") argHint = '';
  else argHint = argHint.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  return { description, argHint };
}

function installCodex(configDir, { useSymlink }) {
  const L = codexLayout(configDir);

  if (useSymlink) {
    console.log('Note: symlink install is unavailable for Codex (artifacts are generated, not copied verbatim); installing copies instead.');
  }

  ensure(L.skillDir);
  ensure(L.referencesDir);
  ensure(L.promptsDir);
  ensure(L.trailheadDir);

  // Engine: clean copy for idempotency, then project with conversion.
  rmrf(L.skillDir);
  copySkillConverted(path.join(SRC, 'skills', 'trailhead'), L.skillDir, true);

  // Templates (verbatim, never converted): the commit-msg git hook the engine
  // installs into .git/hooks at repo first-use lives here, reachable on Codex
  // exactly as on Claude Code. Decision #16 / ticket #22.
  rmrf(L.templatesDir);
  ensure(L.templatesDir);
  fs.cpSync(path.join(SRC, 'templates'), L.templatesDir, { recursive: true });

  // Prompts: clear out any previously generated trailhead prompts, then regenerate.
  rmrf(path.join(L.promptsDir, 'trailhead.md'));
  for (const f of fs.existsSync(L.promptsDir) ? fs.readdirSync(L.promptsDir) : []) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.promptsDir, f));
  }
  ensure(L.promptsDir);

  const commandsDir = path.join(SRC, 'commands');
  const verbs = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  for (const verb of verbs) {
    const md = fs.readFileSync(path.join(commandsDir, `${verb}.md`), 'utf8');
    const { description, argHint } = parseCommandFrontmatter(md);
    const promptBody = codexPromptFor(verb, description, argHint, L.skillMain);
    const promptName = hyphenateCommand(`/trailhead:${verb}`); // -> trailhead-<verb>
    fs.writeFileSync(path.join(L.promptsDir, `${promptName}.md`), promptBody);
  }
  fs.writeFileSync(
    path.join(L.promptsDir, 'trailhead.md'),
    codexPromptFor(null, 'Start or drive a trailhead map (smart entry)', null, L.skillMain)
  );

  // No agents/ dir: emitsAgentToml('codex') is false (host-descriptor.js), so
  // there is nothing to emit here. No hooks/settings.json either: Codex has
  // no hook bus (hooks.bus === 'none').

  const pkgVersion = (readJSON(path.join(SRC, '.claude-plugin', 'plugin.json')).version || '').trim();
  if (pkgVersion) {
    fs.writeFileSync(L.versionFile, pkgVersion + '\n');
  }

  console.log(`✓ trailhead installed for Codex → ${configDir}`);
  console.log(`  prompts → ${L.promptsDir}/  (/trailhead-*)`);
  console.log(`  skill   → ${L.skillMain}`);
  console.log(`  templates → ${L.templatesDir}/`);
  console.log('  no hooks (Codex has no hook bus)');
  console.log('\nRestart or reload Codex to pick up the prompts, then run /trailhead to start.');
}

function uninstallCodex(configDir) {
  const L = codexLayout(configDir);
  rmrf(path.join(L.promptsDir, 'trailhead.md'));
  for (const f of fs.existsSync(L.promptsDir) ? fs.readdirSync(L.promptsDir) : []) {
    if (f.startsWith('trailhead-')) rmrf(path.join(L.promptsDir, f));
  }
  rmrf(L.trailheadDir);
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
