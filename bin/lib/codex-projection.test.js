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
  codexVerbSkillContent,
  codexVerbSkillAgentsYaml,
  codexVerbSkillPlan,
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
ok('codexSkillAdapterHeader §D warns against a single blocking wait_agent with a poll loop',
  header.includes('bounded wait') && header.includes('poll'));
ok('codexSkillAdapterHeader §D offers a background-job fallback for a stalling review',
  header.includes('background job'));
ok('codexSkillAdapterHeader §D makes background+poll the hard cross-host default for reviews',
  header.includes('always run this way') && header.includes('hard cross-host default'));
ok('codexSkillAdapterHeader §F mentions real Codex hooks', header.includes('real Codex hooks'));
ok('codexSkillAdapterHeader §F no longer says Codex has no hook bus', !header.includes('Codex has no hook bus'));
ok('codexSkillAdapterHeader §H maps plan-review external-CLI Bash timeout/background onto Codex shell',
  header.includes('## H.') && header.includes('Cross-AI plan review') && header.includes('run_in_background') && header.includes('shell/exec'));
ok('codexSkillAdapterHeader §H distinguishes the external-CLI shell path from the §D subagent path',
  header.includes('external-CLI') && header.includes('not a spawned Codex subagent'));
ok('codexSkillAdapterHeader §H makes backgrounding reviewers the default',
  header.includes('the default is to background the reviewers'));
ok('codexSkillAdapterHeader §H closes reviewer stdin to avoid the EOF hang',
  header.includes('/dev/null') && header.toLowerCase().includes('stdin'));

// --- codexVerbSkillContent (#46) ---
ok('codexVerbSkillContent: SKILL.md frontmatter is at byte 0 with name+description', (() => {
  const out = codexVerbSkillContent({ verb: 'work', description: 'Work the next frontier ticket' });
  return out.startsWith('---\nname: trailhead-work\n') && out.includes('description: "Work the next frontier ticket"');
})());
ok('codexVerbSkillContent: body delegates to $trailhead <verb>', (() => {
  const out = codexVerbSkillContent({ verb: 'work', description: 'x' });
  return out.includes('`$trailhead work`') && out.includes('single source of truth');
})());
ok('codexVerbSkillContent: falls back to a description when none given', (() => {
  const out = codexVerbSkillContent({ verb: 'update' });
  return out.includes('description: "trailhead update"');
})());
ok('codexVerbSkillContent: YAML-quotes a description with a colon/quote', (() => {
  const out = codexVerbSkillContent({ verb: 'bug', description: 'Capture a bug: "regression"' });
  return out.includes('description: "Capture a bug: \\"regression\\""');
})());

// --- codexVerbSkillAgentsYaml (#46) ---
ok('codexVerbSkillAgentsYaml: explicit-only invocation, no auto-trigger', (() => {
  const out = codexVerbSkillAgentsYaml({ verb: 'work', description: 'x' });
  return out.includes('allow_implicit_invocation: false') && out.includes('display_name: "Trailhead: work"');
})());

// --- codexVerbSkillPlan (#46) ---
ok('codexVerbSkillPlan: one skills/trailhead-<verb>/ dir per verb (SKILL.md + openai.yaml)', (() => {
  const plan = codexVerbSkillPlan('/c', [{ verb: 'work' }, { verb: 'bug' }]);
  return plan.dirs.length === 2 &&
    plan.dirs.includes('/c/skills/trailhead-work') &&
    plan.writes.some((w) => w.path === '/c/skills/trailhead-work/SKILL.md') &&
    plan.writes.some((w) => w.path === '/c/skills/trailhead-work/agents/openai.yaml') &&
    plan.writes.some((w) => w.path === '/c/skills/trailhead-bug/SKILL.md');
})());
ok('codexVerbSkillPlan: never emits a bare trailhead skill ($trailhead already is smart entry)', (() => {
  const plan = codexVerbSkillPlan('/c', [{ verb: 'work' }]);
  return !plan.dirs.includes('/c/skills/trailhead') && !plan.writes.some((w) => w.path === '/c/skills/trailhead/SKILL.md');
})());
ok('codexVerbSkillPlan: accepts a bare-string verb and skips empty/invalid', (() => {
  const plan = codexVerbSkillPlan('/c', [{ verb: '' }, { verb: null }, 'work']);
  return plan.dirs.length === 1 && plan.dirs[0] === '/c/skills/trailhead-work';
})());
ok('codexVerbSkillPlan: null verbs yields nothing', codexVerbSkillPlan('/c', null).dirs.length === 0 && codexVerbSkillPlan('/c').dirs.length === 0);

// --- codexHookEntries ---
const entries = codexHookEntries('/h');
ok('codexHookEntries returns 7 entries', Array.isArray(entries) && entries.length === 7);
ok('codexHookEntries: commit-guard is PreToolUse/Bash', entries.some((e) =>
  e.event === 'PreToolUse' && e.matcher === 'Bash' && e.command.includes('trailhead-commit-guard.js') && e.command.includes('/h')));
ok('codexHookEntries: secret-guard is PreToolUse/Bash', entries.some((e) =>
  e.event === 'PreToolUse' && e.matcher === 'Bash' && e.command.includes('trailhead-secret-guard.js')));
ok('codexHookEntries: install-guard is PreToolUse/Bash', entries.some((e) =>
  e.event === 'PreToolUse' && e.matcher === 'Bash' && e.command.includes('trailhead-install-guard.js')));
ok('codexHookEntries: search-guard is PreToolUse/Bash', entries.some((e) =>
  e.event === 'PreToolUse' && e.matcher === 'Bash' && e.command.includes('trailhead-search-guard.js')));
ok('codexHookEntries: secret-read-guard is PreToolUse/Read|Bash', entries.some((e) =>
  e.event === 'PreToolUse' && e.matcher === 'Read|Bash' && e.command.includes('trailhead-secret-read-guard.js')));
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
ok('codexAgentToml with no model emits a pin-less TOML (no model line, no effort line, keeps the rest)', (() => {
  const out = codexAgentToml({
    name: 'trailhead-fix',
    description: 'desc',
    developerInstructions: 'fix the thing',
    model: null,
    effort: null,
  });
  return out.includes('name = "trailhead-fix"') &&
    out.includes('description = "desc"') &&
    !/^model = /m.test(out) &&
    !out.includes('model_reasoning_effort') &&
    out.includes("developer_instructions = '''") &&
    out.includes('fix the thing');
})());

ok('codexAgentToml escapes a " and \\ in name/description so the TOML stays valid', (() => {
  const out = codexAgentToml({
    name: 'trailhead-plan',
    description: 'has a "quote" and a back\\slash',
    developerInstructions: 'body',
    model: null,
    effort: null,
  });
  // The emitted basic string must carry escaped forms, never a raw " that
  // would prematurely close the TOML string.
  return out.includes('description = "has a \\"quote\\" and a back\\\\slash"');
})());

// --- codexAgentTomlPlan ---
// 7-entry stub agentDefs mirroring the real plugins/trailhead/agents/*.md
// sources: 6 keyed techniques (plan/execute/research/review/debug/codebase-map,
// whose filenames derive from trailhead-executor -> execute and
// trailhead-code-review -> review) + 1 always-keyless agent (fix).
const STUB_AGENT_DEFS = [
  { name: 'trailhead-plan', description: 'plan desc', tools: 'Read', body: 'Plan body.' },
  { name: 'trailhead-executor', description: 'execute desc', tools: 'Read, Write', body: 'Execute body.' },
  { name: 'trailhead-research', description: 'research desc', tools: 'Read', body: 'Research body.' },
  { name: 'trailhead-code-review', description: 'review desc', tools: 'Read', body: 'Review body.' },
  { name: 'trailhead-debug', description: 'debug desc', tools: 'Read', body: 'Debug body.' },
  { name: 'trailhead-fix', description: 'fix desc', tools: 'Read, Write', body: 'Fix body.' },
  { name: 'trailhead-codebase-map', description: 'map desc', tools: 'Read', body: 'Map body.' },
];

ok('codexAgentTomlPlan: 7 agentDefs -> 7 writes with only the pinned key carrying a model', (() => {
  const plan = codexAgentTomlPlan('/c', { execute: 'gpt-5.6-terra' }, STUB_AGENT_DEFS);
  if (plan.writes.length !== 7) return false;
  const byName = Object.fromEntries(plan.writes.map((w) => [w.name, w]));
  const execute = byName['trailhead-execute'];
  if (!execute || execute.path !== '/c/agents/trailhead-execute.toml') return false;
  if (!execute.content.includes('model = "gpt-5.6-terra"')) return false;
  const others = plan.writes.filter((w) => w.name !== 'trailhead-execute');
  return others.length === 6 && others.every((w) => !/^model = /m.test(w.content));
})());

ok('codexAgentTomlPlan: keyless trailhead-fix stays pin-less; trailhead-codebase-map now pins on codebase-map', (() => {
  const plan = codexAgentTomlPlan('/c', { fix: 'gpt-5.6-terra', 'codebase-map': 'gpt-5.6-terra' }, STUB_AGENT_DEFS);
  const byName = Object.fromEntries(plan.writes.map((w) => [w.name, w]));
  const fix = byName['trailhead-fix'];
  const map = byName['trailhead-codebase-map'];
  return fix && map &&
    fix.path === '/c/agents/trailhead-fix.toml' && !/^model = /m.test(fix.content) &&
    map.path === '/c/agents/trailhead-codebase-map.toml' && map.content.includes('model = "gpt-5.6-terra"');
})());

ok('codexAgentTomlPlan: empty models object -> 7 pin-less writes (not zero)', (() => {
  const plan = codexAgentTomlPlan('/c', {}, STUB_AGENT_DEFS);
  return plan.writes.length === 7 && plan.writes.every((w) => !/^model = /m.test(w.content));
})());

ok('codexAgentTomlPlan: null models -> 7 pin-less writes (not zero)', (() => {
  const plan = codexAgentTomlPlan('/c', null, STUB_AGENT_DEFS);
  return plan.writes.length === 7 && plan.writes.every((w) => !/^model = /m.test(w.content));
})());

ok('codexAgentTomlPlan: object model value on the execute key carries model + model_reasoning_effort', (() => {
  const plan = codexAgentTomlPlan('/c', { execute: { model: 'gpt-5.6-sol', effort: 'high' } }, STUB_AGENT_DEFS);
  const execute = plan.writes.find((w) => w.name === 'trailhead-execute');
  return execute.content.includes('model = "gpt-5.6-sol"') && execute.content.includes('model_reasoning_effort = "high"');
})());

ok('codexAgentTomlPlan: a keyed key whose object value has no model stays pin-less', (() => {
  const plan = codexAgentTomlPlan('/c', { execute: { effort: 'high' } }, STUB_AGENT_DEFS);
  const execute = plan.writes.find((w) => w.name === 'trailhead-execute');
  return plan.writes.length === 7 && !/^model = /m.test(execute.content) && !execute.content.includes('model_reasoning_effort');
})());

ok('codexAgentTomlPlan: description is routed through convertToCodex (host paths rewritten)', (() => {
  const defs = [{ name: 'trailhead-plan', description: 'see ~/.claude/skills', tools: 'Read', body: 'b' }];
  const plan = codexAgentTomlPlan('/c', {}, defs);
  return plan.writes[0].content.includes('description = "see ~/.codex/skills"');
})());

ok('codexAgentTomlPlan: a missing description renders as an empty string, not "undefined"', (() => {
  const defs = [{ name: 'trailhead-plan', tools: 'Read', body: 'b' }];
  const plan = codexAgentTomlPlan('/c', {}, defs);
  return plan.writes[0].content.includes('description = ""') && !plan.writes[0].content.includes('description = "undefined"');
})());

ok('codexAgentTomlPlan: empty/undefined agentDefs -> no writes (installer then leaves multi_agent_v2 off)', (() => {
  return codexAgentTomlPlan('/c', {}, []).writes.length === 0 &&
    codexAgentTomlPlan('/c', {}).writes.length === 0 &&
    codexAgentTomlPlan('/c', {}, null).writes.length === 0;
})());

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
