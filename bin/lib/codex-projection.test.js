#!/usr/bin/env node
// Tests for codex-projection.js. Run: node codex-projection.test.js
// No framework: plain asserts, mirrors the style of host-descriptor.test.js.
const assert = require('assert');
const {
  codexLayout,
  convertToCodex,
  codexSkillAdapterHeader,
  codexPromptFor,
} = require('./codex-projection.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- convertToCodex: command surface ---
ok('convertToCodex rewrites /trailhead:work to /trailhead-work', convertToCodex('/trailhead:work') === '/trailhead-work');
ok('convertToCodex leaves bare labels untouched', convertToCodex('label trailhead:build stays').includes('trailhead:build'));

// --- convertToCodex: /clear -> /new ---
ok('convertToCodex rewrites /clear to /new', (() => {
  const out = convertToCodex('run `/clear` now');
  return out.includes('/new') && !out.includes('/clear');
})());

// --- convertToCodex: paths ---
ok('convertToCodex rewrites ~/.claude/foo', convertToCodex('~/.claude/foo') === '~/.codex/foo');
ok('convertToCodex rewrites $HOME/.claude', convertToCodex('$HOME/.claude') === '$HOME/.codex');
ok('convertToCodex rewrites bare .claude/', convertToCodex('see .claude/skills/').includes('.codex/skills/'));

// --- convertToCodex: plugin root ---
ok('convertToCodex rewrites CLAUDE_PLUGIN_ROOT', convertToCodex('${CLAUDE_PLUGIN_ROOT}/hooks').includes('~/.codex/trailhead/skill/hooks'));

// --- codexLayout ---
const layout = codexLayout('/c');
ok('codexLayout skillMain', layout.skillMain === '/c/trailhead/skill/SKILL.md');
ok('codexLayout promptsDir', layout.promptsDir === '/c/prompts');
ok('codexLayout versionFile', layout.versionFile === '/c/trailhead/VERSION');
ok('codexLayout templatesDir', layout.templatesDir === '/c/trailhead/templates');

// --- codexSkillAdapterHeader ---
const header = codexSkillAdapterHeader();
ok('codexSkillAdapterHeader has adapter tag', header.includes('<codex_skill_adapter>'));
ok('codexSkillAdapterHeader mentions request_user_input', header.includes('request_user_input'));
ok('codexSkillAdapterHeader mentions hyphen command form', header.includes('/trailhead-<verb>'));

// --- codexPromptFor: verb ---
const workPrompt = codexPromptFor('work', 'Work the next ticket', '[ticket]', '/c/trailhead/skill/SKILL.md');
ok('codexPromptFor(work) contains skillMainAbsPath', workPrompt.includes('/c/trailhead/skill/SKILL.md'));
ok('codexPromptFor(work) contains $ARGUMENTS', workPrompt.includes('$ARGUMENTS'));
ok('codexPromptFor(work) contains bold verb', workPrompt.includes('**work**'));
ok('codexPromptFor(work) contains quoted description line', workPrompt.includes('description: "Work the next ticket"'));

// A description carrying a colon must be YAML-quoted, not emitted raw (else
// `key: a: b` is ambiguous YAML and a strict parser rejects the frontmatter).
const colonPrompt = codexPromptFor('seed', 'Capture a seed: work gated on a future trigger', '[text]', '/c/SKILL.md');
ok('codexPromptFor quotes a colon-bearing description', colonPrompt.includes('description: "Capture a seed: work gated on a future trigger"'));
ok('codexPromptFor quotes argument-hint', colonPrompt.includes('argument-hint: "[text]"'));

// --- codexPromptFor: bare (smart entry) ---
const barePrompt = codexPromptFor(null, 'Smart entry', null, '/c/skill/SKILL.md');
ok('codexPromptFor(null) mentions smart entry', barePrompt.includes('smart entry'));
ok('codexPromptFor(null) has no argument-hint line', !barePrompt.includes('argument-hint:'));

console.log(`✓ codex-projection: ${passed} assertions passed`);
