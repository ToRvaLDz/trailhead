#!/usr/bin/env node
// Tests for codex-projection.js. Run: node codex-projection.test.js
// No framework: plain asserts, mirrors the style of host-descriptor.test.js.
const assert = require('assert');
const {
  codexLayout,
  convertToCodex,
  codexSkillAdapterHeader,
  injectCodexAdapterHeader,
  codexAgentsYaml,
  codexAgentToml,
  codexAgentTomlPlan,
  codexPromptShimContent,
  codexPromptShimPlan,
  codexHookEntries,
  enableCodexHooksFeature,
  enableCodexMultiAgentV2Feature,
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
ok('codexLayout hooksScriptsDir', layout.hooksScriptsDir === '/c/skills/trailhead/hooks');
ok('codexLayout hooksJson', layout.hooksJson === '/c/hooks.json');
ok('codexLayout configToml', layout.configToml === '/c/config.toml');
ok('codexLayout codexAgentsDir', layout.codexAgentsDir === '/c/agents');

// --- codexSkillAdapterHeader ---
const header = codexSkillAdapterHeader();
ok('codexSkillAdapterHeader has adapter tag', header.includes('<codex_skill_adapter>'));
ok('codexSkillAdapterHeader mentions request_user_input', header.includes('request_user_input'));
ok('codexSkillAdapterHeader mentions $trailhead <verb> form', header.includes('$trailhead <verb>'));
ok('codexSkillAdapterHeader does not mention the legacy hyphen form', !header.includes('/trailhead-<verb>'));
ok('codexSkillAdapterHeader §D describes native multi_agent spawning',
  header.includes('spawn_agent') && header.includes('multi_agent'));
ok('codexSkillAdapterHeader §D says subagents inherit the one session model',
  header.includes('inherit the one session model'));
ok('codexSkillAdapterHeader §D dispatches by agent_type under multi_agent_v2',
  header.includes('agent_type') && header.includes('multi_agent_v2'));
ok('codexSkillAdapterHeader §D detects the registry by spawn_agent schema introspection',
  header.includes('spawn_agent') && header.includes('schema'));
ok('codexSkillAdapterHeader §D no longer calls per-subagent model pinning deferred',
  !header.includes('deferred'));
ok('codexSkillAdapterHeader §D pins the exact agent_type dispatch call shape',
  header.includes('spawn_agent(agent_type="trailhead-<technique>"'));
ok('codexSkillAdapterHeader §D keeps the base spawn_agent v1 fallback path',
  header.includes('base multi_agent v1') && header.includes('inherit the one session model'));
ok('codexSkillAdapterHeader §F mentions real Codex hooks', header.includes('real Codex hooks'));
ok('codexSkillAdapterHeader §F no longer says Codex has no hook bus', !header.includes('Codex has no hook bus'));

// --- codexPromptShimContent (#41) ---
ok('codexPromptShimContent: verb shim delegates to $trailhead <verb> $ARGUMENTS', (() => {
  const out = codexPromptShimContent({ verb: 'work', description: 'Work the next frontier ticket', argumentHint: '"[ticket]"' });
  return out.includes('$trailhead work $ARGUMENTS') && out.includes('description: Work the next frontier ticket') && out.includes('argument-hint: "[ticket]"');
})());
ok('codexPromptShimContent: bare shim is smart entry ($trailhead $ARGUMENTS)', (() => {
  const out = codexPromptShimContent({ verb: null });
  return out.includes('$trailhead $ARGUMENTS') && !out.includes('$trailhead null');
})());
ok('codexPromptShimContent: omits argument-hint when absent', (() => {
  const out = codexPromptShimContent({ verb: 'update', description: 'Check for a newer trailhead' });
  return out.includes('description: Check for a newer trailhead') && !out.includes('argument-hint');
})());
ok('codexPromptShimContent: delegates, does not re-implement engine logic', codexPromptShimContent({ verb: 'work' }).includes('single source of truth'));

// --- codexPromptShimPlan (#41) ---
ok('codexPromptShimPlan: always emits the bare trailhead.md', (() => {
  const plan = codexPromptShimPlan('/c', [{ verb: 'work' }]);
  return plan.writes.some((w) => w.path === '/c/prompts/trailhead.md' && w.verb === null);
})());
ok('codexPromptShimPlan: one trailhead-<verb>.md per verb', (() => {
  const plan = codexPromptShimPlan('/c', [{ verb: 'work' }, { verb: 'bug' }]);
  return plan.writes.length === 3 &&
    plan.writes.some((w) => w.path === '/c/prompts/trailhead-work.md') &&
    plan.writes.some((w) => w.path === '/c/prompts/trailhead-bug.md');
})());
ok('codexPromptShimPlan: accepts a bare-string verb and skips empty/invalid', (() => {
  const plan = codexPromptShimPlan('/c', [{ verb: '' }, { verb: null }, 'work']);
  return plan.writes.length === 2 && plan.writes.some((w) => w.path === '/c/prompts/trailhead-work.md');
})());
ok('codexPromptShimPlan: null verbs yields only the bare shim', codexPromptShimPlan('/c', null).writes.length === 1 && codexPromptShimPlan('/c').writes.length === 1);

// --- codexLayout rename (#41) ---
ok('codexLayout promptsDir', codexLayout('/c').promptsDir === '/c/prompts');

// --- codexHookEntries ---
const entries = codexHookEntries('/h');
ok('codexHookEntries returns 4 entries', Array.isArray(entries) && entries.length === 4);
ok('codexHookEntries: commit-guard is PreToolUse/Bash', entries.some((e) =>
  e.event === 'PreToolUse' && e.matcher === 'Bash' && e.command.includes('trailhead-commit-guard.js') && e.command.includes('/h')));
ok('codexHookEntries: secret-guard is PreToolUse/Bash', entries.some((e) =>
  e.event === 'PreToolUse' && e.matcher === 'Bash' && e.command.includes('trailhead-secret-guard.js')));
ok('codexHookEntries: injection-scanner is PostToolUse/Bash', entries.some((e) =>
  e.event === 'PostToolUse' && e.matcher === 'Bash' && e.command.includes('trailhead-issue-injection-scanner.js')));
ok('codexHookEntries: check-update is SessionStart', entries.some((e) =>
  e.event === 'SessionStart' && e.command.includes('trailhead-check-update.js')));

// --- enableCodexHooksFeature ---
ok('enableCodexHooksFeature(empty) appends [features] table with hooks = true', (() => {
  const out = enableCodexHooksFeature('');
  return typeof out === 'string' && out.includes('[features]') && out.includes('hooks = true');
})());
ok('enableCodexHooksFeature: already enabled -> null', enableCodexHooksFeature('[features]\nhooks = true\n') === null);
ok('enableCodexHooksFeature: inserts hooks = true into existing [features]', (() => {
  const out = enableCodexHooksFeature('[features]\nfoo = 1\n');
  return typeof out === 'string' && out.includes('hooks = true') && (out.match(/\[features\]/g) || []).length === 1;
})());
ok('enableCodexHooksFeature: flips hooks = false to true', (() => {
  const out = enableCodexHooksFeature('[features]\nhooks = false\n');
  return typeof out === 'string' && out.includes('hooks = true') && !out.includes('hooks = false');
})());
ok('enableCodexHooksFeature: appends [features] table when none exists', (() => {
  const out = enableCodexHooksFeature('[other]\nk = 1\n');
  return typeof out === 'string' && out.includes('[other]') && out.includes('[features]') && out.includes('hooks = true');
})());
ok('enableCodexHooksFeature: dotted top-level form already true -> null', enableCodexHooksFeature('features.hooks = true\n') === null);

// --- codexAgentToml ---
ok('codexAgentToml with effort includes model + model_reasoning_effort + developer_instructions block', (() => {
  const out = codexAgentToml({
    name: 'trailhead-execute',
    description: 'desc',
    developerInstructions: 'do the thing',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  return out.includes('name = "trailhead-execute"') &&
    out.includes('model = "gpt-5.6-sol"') &&
    out.includes('model_reasoning_effort = "high"') &&
    out.includes("developer_instructions = '''") &&
    out.includes('do the thing');
})());
ok('codexAgentToml without effort omits model_reasoning_effort', (() => {
  const out = codexAgentToml({
    name: 'trailhead-plan',
    description: 'desc',
    developerInstructions: 'plan the thing',
    model: 'gpt-5.6-terra',
    effort: null,
  });
  return out.includes('model = "gpt-5.6-terra"') && !out.includes('model_reasoning_effort');
})());

// --- codexAgentTomlPlan ---
ok('codexAgentTomlPlan: string value produces one write with the right path/name/model', (() => {
  const plan = codexAgentTomlPlan('/c', { execute: 'gpt-5.6-terra' });
  return plan.writes.length === 1 &&
    plan.writes[0].path === '/c/agents/trailhead-execute.toml' &&
    plan.writes[0].name === 'trailhead-execute' &&
    plan.writes[0].content.includes('model = "gpt-5.6-terra"');
})());
ok('codexAgentTomlPlan: object value includes model + effort', (() => {
  const plan = codexAgentTomlPlan('/c', { execute: { model: 'gpt-5.6-sol', effort: 'high' } });
  const c = plan.writes[0].content;
  return c.includes('model = "gpt-5.6-sol"') && c.includes('model_reasoning_effort = "high"');
})());
ok('codexAgentTomlPlan: empty object -> no writes', codexAgentTomlPlan('/c', {}).writes.length === 0);
ok('codexAgentTomlPlan: null -> no writes', codexAgentTomlPlan('/c', null).writes.length === 0);
ok('codexAgentTomlPlan: unknown key skipped', codexAgentTomlPlan('/c', { bogus: 'x' }).writes.length === 0);
ok('codexAgentTomlPlan: object value with no model is skipped', codexAgentTomlPlan('/c', { execute: { effort: 'high' } }).writes.length === 0);

// --- enableCodexMultiAgentV2Feature ---
ok('enableCodexMultiAgentV2Feature: dotted form already true -> null',
  enableCodexMultiAgentV2Feature('features.multi_agent_v2 = true\n') === null);
ok('enableCodexMultiAgentV2Feature: inserts into existing [features] table', (() => {
  const out = enableCodexMultiAgentV2Feature('[features]\nfoo = 1\n');
  return typeof out === 'string' && out.includes('multi_agent_v2 = true') && (out.match(/\[features\]/g) || []).length === 1;
})());
ok('enableCodexMultiAgentV2Feature: appends a table when none exists', (() => {
  const out = enableCodexMultiAgentV2Feature('[other]\nk = 1\n');
  return typeof out === 'string' && out.includes('[other]') && out.includes('[features]') && out.includes('multi_agent_v2 = true');
})());
ok('enableCodexMultiAgentV2Feature: foreign explicit value is unsafe',
  (() => {
    const out = enableCodexMultiAgentV2Feature('features.multi_agent_v2 = "x"\n');
    return out && out.unsafe === true;
  })());

// --- enableCodexHooksFeature regression (still works after generalisation) ---
ok('enableCodexHooksFeature regression: still yields hooks = true', (() => {
  const out = enableCodexHooksFeature('[features]\nfoo = 1\n');
  return typeof out === 'string' && out.includes('hooks = true');
})());

// --- injectCodexAdapterHeader (frontmatter stays at the top: #40) ---
// A realistic converted SKILL.md: YAML frontmatter first, then body.
const skillMain = '---\nname: trailhead\ndescription: "chart & work a map"\nargument-hint: "[work] [ticket]"\n---\n\nA loose idea has arrived.\n';
const injected = injectCodexAdapterHeader(skillMain);
ok('injectCodexAdapterHeader keeps the projected SKILL.md starting with ---', injected.startsWith('---\n'));
ok('injectCodexAdapterHeader keeps the frontmatter before the adapter header',
  injected.indexOf('name: trailhead') < injected.indexOf('<codex_skill_adapter>'));
ok('injectCodexAdapterHeader still injects the adapter header', injected.includes('<codex_skill_adapter>'));
ok('injectCodexAdapterHeader preserves the body', injected.includes('A loose idea has arrived.'));
ok('injectCodexAdapterHeader places the header after the closing --- of the frontmatter',
  injected.indexOf('<codex_skill_adapter>') > injected.indexOf('\n---\n'));
// Fallback: no frontmatter -> header still prepended (nothing to protect).
ok('injectCodexAdapterHeader falls back to prepend when there is no frontmatter', (() => {
  const out = injectCodexAdapterHeader('just a body, no frontmatter\n');
  return out.startsWith('<codex_skill_adapter>') && out.includes('just a body');
})());

// --- codexAgentsYaml ---
const agentsYaml = codexAgentsYaml();
ok('codexAgentsYaml disallows implicit invocation', agentsYaml.includes('allow_implicit_invocation: false'));
ok('codexAgentsYaml mentions $trailhead', agentsYaml.includes('$trailhead'));
ok('codexAgentsYaml has the display name', agentsYaml.includes('display_name: "Trailhead"'));

console.log(`✓ codex-projection: ${passed} assertions passed`);
