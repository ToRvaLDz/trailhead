#!/usr/bin/env node
// Tests for codex-projection.js. Run: node codex-projection.test.js
// No framework: plain asserts, mirrors the style of host-descriptor.test.js.
const assert = require('assert');
const {
  codexLayout,
  convertToCodex,
  codexSkillAdapterHeader,
  codexAgentsYaml,
} = require('./codex-projection.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- convertToCodex: command surface ---
ok('convertToCodex rewrites /trailhead:work to $trailhead work', convertToCodex('/trailhead:work') === '$trailhead work');
ok('convertToCodex rewrites bare /trailhead to $trailhead', (() => {
  const out = convertToCodex('run /trailhead now');
  return out.includes('$trailhead') && !out.includes('/trailhead ');
})());
ok('convertToCodex leaves bare labels untouched', convertToCodex('label trailhead:build stays').includes('trailhead:build'));
// Regression: the bare-command rule must NOT eat `/trailhead` inside a path
// segment (a \b boundary before `/` or `-` used to corrupt these).
ok('convertToCodex preserves a /trailhead/ path segment',
  convertToCodex('read ~/.codex/skills/trailhead/references/foo.md').includes('/skills/trailhead/references/'));
ok('convertToCodex preserves a /trailhead- filename',
  convertToCodex('copy templates/trailhead-commit-msg here').includes('templates/trailhead-commit-msg'));

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
ok('convertToCodex rewrites CLAUDE_PLUGIN_ROOT', convertToCodex('${CLAUDE_PLUGIN_ROOT}/templates').includes('~/.codex/skills/trailhead/templates'));

// --- codexLayout ---
const layout = codexLayout('/c');
ok('codexLayout skillDir', layout.skillDir === '/c/skills/trailhead');
ok('codexLayout skillMain', layout.skillMain === '/c/skills/trailhead/SKILL.md');
ok('codexLayout versionFile', layout.versionFile === '/c/skills/trailhead/VERSION');
ok('codexLayout templatesDir', layout.templatesDir === '/c/skills/trailhead/templates');
ok('codexLayout agentsYaml', layout.agentsYaml === '/c/skills/trailhead/agents/openai.yaml');

// --- codexSkillAdapterHeader ---
const header = codexSkillAdapterHeader();
ok('codexSkillAdapterHeader has adapter tag', header.includes('<codex_skill_adapter>'));
ok('codexSkillAdapterHeader mentions request_user_input', header.includes('request_user_input'));
ok('codexSkillAdapterHeader mentions $trailhead <verb> form', header.includes('$trailhead <verb>'));
ok('codexSkillAdapterHeader does not mention the legacy hyphen form', !header.includes('/trailhead-<verb>'));

// --- codexAgentsYaml ---
const agentsYaml = codexAgentsYaml();
ok('codexAgentsYaml disallows implicit invocation', agentsYaml.includes('allow_implicit_invocation: false'));
ok('codexAgentsYaml mentions $trailhead', agentsYaml.includes('$trailhead'));
ok('codexAgentsYaml has the display name', agentsYaml.includes('display_name: "Trailhead"'));

console.log(`✓ codex-projection: ${passed} assertions passed`);
