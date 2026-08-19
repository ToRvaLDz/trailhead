#!/usr/bin/env node
'use strict';
// trailhead installer — places the skill, commands, hooks, and templates into
// an agent's config dir, and registers the hooks in settings.json.
// No dependencies. Idempotent. Usage:
//   npx @marcomigozzi/trailhead            install for Claude Code (~/.claude or $CLAUDE_CONFIG_DIR)
//   npx @marcomigozzi/trailhead --symlink  dev install (symlink to the package, live edits)
//   npx @marcomigozzi/trailhead --uninstall
//   npx @marcomigozzi/trailhead --dir=/path/to/configdir
//
// Multi-CLI: only the Claude adapter exists today. Add adapters below (config dir,
// commands/hooks layout) to target Codex, Gemini, etc. — see ADAPTERS.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG = path.resolve(__dirname, '..');
const SRC = path.join(PKG, 'plugins', 'trailhead');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const useSymlink = has('--symlink');
const uninstall = has('--uninstall');
const dirArg = (args.find((a) => a.startsWith('--dir=')) || '').split('=')[1];

// --- ADAPTERS: one config layout per target agent. Extend this map for multi-CLI. ---
const ADAPTERS = {
  claude: {
    label: 'Claude Code',
    configDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  },
  // codex:  { label: 'Codex',  configDir: process.env.CODEX_HOME  || path.join(os.homedir(), '.codex')  },
  // gemini: { label: 'Gemini', configDir: process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), '.gemini') },
};
const adapter = ADAPTERS.claude; // only Claude for now
const configDir = dirArg || adapter.configDir;

const P = {
  skill: path.join(configDir, 'skills', 'trailhead'),
  commands: path.join(configDir, 'commands', 'trailhead'),
  hooksDir: path.join(configDir, 'hooks'),
  templates: path.join(configDir, 'trailhead', 'templates'),
  settings: path.join(configDir, 'settings.json'),
};
const HOOK_FILES = ['trailhead-commit-guard.js', 'trailhead-issue-injection-scanner.js', 'trailhead-secret-guard.js'];
const hookCmd = (name) => `node "${path.join(P.hooksDir, name)}"`;

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const ensure = (p) => fs.mkdirSync(p, { recursive: true });
function place(src, dest) {
  rmrf(dest);
  ensure(path.dirname(dest));
  if (useSymlink) fs.symlinkSync(src, dest, 'dir');
  else fs.cpSync(src, dest, { recursive: true });
}
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const writeJSON = (p, o) => { ensure(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };

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

if (uninstall) {
  [P.skill, P.commands, path.join(configDir, 'trailhead')].forEach(rmrf);
  HOOK_FILES.forEach((f) => rmrf(path.join(P.hooksDir, f)));
  const s = readJSON(P.settings);
  stripHook(s, 'PreToolUse', 'trailhead-commit-guard.js');
  stripHook(s, 'PreToolUse', 'trailhead-secret-guard.js');
  stripHook(s, 'PostToolUse', 'trailhead-issue-injection-scanner.js');
  writeJSON(P.settings, s);
  console.log(`trailhead uninstalled from ${configDir}`);
  process.exit(0);
}

// install (Claude adapter)
place(path.join(SRC, 'skills', 'trailhead'), P.skill);
place(path.join(SRC, 'commands'), P.commands);
place(path.join(SRC, 'templates'), P.templates);
ensure(P.hooksDir);
for (const f of HOOK_FILES) {
  fs.copyFileSync(path.join(SRC, 'hooks', f), path.join(P.hooksDir, f));
  fs.chmodSync(path.join(P.hooksDir, f), 0o755);
}
const s = readJSON(P.settings);
const added = [
  addHook(s, 'PreToolUse', 'Bash', hookCmd('trailhead-commit-guard.js')),
  addHook(s, 'PreToolUse', 'Bash', hookCmd('trailhead-secret-guard.js')),
  addHook(s, 'PostToolUse', 'Bash', hookCmd('trailhead-issue-injection-scanner.js')),
].some(Boolean);
writeJSON(P.settings, s);

console.log(`✓ trailhead installed for ${adapter.label} → ${configDir}`);
console.log(`  skill     → ${P.skill}${useSymlink ? '  (symlink)' : ''}`);
console.log(`  commands  → ${P.commands}  (/trailhead:*)`);
console.log(`  hooks     → ${P.hooksDir}/  (${added ? 'registered' : 'already present'} in settings.json)`);
console.log(`  templates → ${P.templates}`);
console.log('\nRestart or reload your agent to pick up the commands, then run /trailhead to start.');
console.log('Note: the commit guard now runs on every git commit (conventional + no Co-Authored-By).');
