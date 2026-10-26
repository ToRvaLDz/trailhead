#!/usr/bin/env node
// Tests for scripts/sync-agent-blocks.js and its source scripts/agent-blocks.md.
// Run: node sync-agent-blocks.test.js
// No framework: plain asserts, same style as the hooks/lib tests.
//
// Layers covered:
//   1. Pure parseSource() / renderAgent().
//   2. The real agents under plugins/trailhead/agents/ against the real source
//      (the drift check: a stale agent fails here as it does under --check).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const agentsDir = path.join(root, 'plugins', 'trailhead', 'agents');
const sourcePath = path.join(__dirname, 'agent-blocks.md');
const { parseSource, renderAgent, FAMILIES, FAMILY_NAMES } = require('./sync-agent-blocks.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const open = (n) => `<!-- trailhead:agent-block ${n} -->`;
const close = (n) => `<!-- /trailhead:agent-block ${n} -->`;
const throws = (fn) => { try { fn(); } catch (e) { return true; } return false; };

const agentNames = fs.readdirSync(agentsDir)
  .filter((f) => /^trailhead-.*\.md$/.test(f))
  .map((f) => f.slice(0, -3))
  .sort();
const readAgent = (name) => fs.readFileSync(path.join(agentsDir, `${name}.md`), 'utf8');
const source = fs.readFileSync(sourcePath, 'utf8');
const blocks = parseSource(source);

// --- parseSource ---------------------------------------------------------------
{
  const text = `preamble, ignored\n\n${open('common')}\nline a\nline b\n${close('common')}\n\nbetween\n\n${open('reviewing')}\n\nrev\n\n${close('reviewing')}\n`;
  const b = parseSource(text);
  ok('parseSource: one entry per block, in order', JSON.stringify(Object.keys(b)) === JSON.stringify(['common', 'reviewing']));
  ok('parseSource: content is the text between the markers', b.common === 'line a\nline b');
  ok('parseSource: surrounding blank lines are trimmed', b.reviewing === 'rev');
  ok('parseSource: text without markers yields no blocks', Object.keys(parseSource('nothing here\n')).length === 0);
  ok('parseSource: an unclosed block throws', throws(() => parseSource(`${open('common')}\nx\n`)));
  ok('parseSource: a duplicate block throws', throws(() => parseSource(`${open('a')}\nx\n${close('a')}\n${open('a')}\ny\n${close('a')}\n`)));
}

// --- renderAgent ---------------------------------------------------------------
const FM = '---\nname: trailhead-verify\ncolor: pink\n---\n';
const BODY = 'Intro paragraph.\n\nSecond paragraph.\n';
const B = { common: 'COMMON TEXT', reviewing: 'REVIEWING TEXT' };
{
  const out = renderAgent(FM + '\n' + BODY, B, 'reviewing');
  ok('renderAgent: keeps the frontmatter untouched', out.startsWith(FM));
  ok('renderAgent: keeps the body before the blocks', out.includes(BODY.trimEnd()));
  const iCommon = out.indexOf(open('common'));
  const iRev = out.indexOf(open('reviewing'));
  ok('renderAgent: appends the common block then the family block', iCommon > 0 && iRev > iCommon);
  ok('renderAgent: block is wrapped by its markers around the content',
    out.includes(`${open('common')}\nCOMMON TEXT\n${close('common')}`) &&
    out.includes(`${open('reviewing')}\nREVIEWING TEXT\n${close('reviewing')}`));
  ok('renderAgent: ends with a single newline', out.endsWith('\n') && !out.endsWith('\n\n'));
  ok('renderAgent: idempotent', renderAgent(out, B, 'reviewing') === out);

  const stale = out.replace('COMMON TEXT', 'OLD TEXT\nmore old');
  const fixed = renderAgent(stale, B, 'reviewing');
  ok('renderAgent: replaces stale content between existing markers', fixed === out);

  const onlyCommon = renderAgent(FM + '\n' + BODY, { common: 'COMMON TEXT' }, 'reviewing');
  ok('renderAgent: a family without a source block gets the common block only',
    onlyCommon.includes(open('common')) && !onlyCommon.includes('agent-block reviewing'));

  const noReplace = FM + '\n' + BODY + '\n' + open('common') + '\nOLD\n' + close('common') + '\n';
  const added = renderAgent(noReplace, B, 'reviewing');
  ok('renderAgent: a missing family block is appended after an existing common block',
    added.indexOf(open('common')) < added.indexOf(open('reviewing')) && !added.includes('OLD'));

  const pair = `${open('common')}\nOLD\n${close('common')}`;
  ok('renderAgent: an open marker without a close throws',
    throws(() => renderAgent(`${FM}\n${BODY}\n${open('common')}\nOLD\n`, B, 'reviewing')));
  ok('renderAgent: a close marker without an open throws',
    throws(() => renderAgent(`${FM}\n${BODY}\nOLD\n${close('common')}\n`, B, 'reviewing')));
  ok('renderAgent: two marker pairs for the same block throw',
    throws(() => renderAgent(`${FM}\n${BODY}\n${pair}\n\n${pair}\n`, B, 'reviewing')));
  ok('renderAgent: a close before its open throws',
    throws(() => renderAgent(`${FM}\n${BODY}\n${close('common')}\n${open('common')}\n`, B, 'reviewing')));
  ok('renderAgent: an unbalanced marker of a block this agent does not use throws',
    throws(() => renderAgent(`${FM}\n${BODY}\n${open('implementing')}\nx\n`, B, 'reviewing')));
  ok('renderAgent: unknown family throws', throws(() => renderAgent(FM + BODY, B, 'nope')));
  ok('renderAgent: unknown agent throws',
    throws(() => renderAgent(FM.replace('trailhead-verify', 'trailhead-ghost') + BODY, B, 'reviewing')));
  ok('renderAgent: missing common block in the source throws',
    throws(() => renderAgent(FM + BODY, { reviewing: 'x' }, 'reviewing')));
}

// --- syncAll agrees with renderAgent on the agent identity ------------------------
{
  const os = require('os');
  const { syncAll } = require('./sync-agent-blocks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailhead-sync-agent-blocks-test-'));
  const src = path.join(dir, 'blocks.md');
  fs.writeFileSync(src, `${open('common')}\nC\n${close('common')}\n`);
  fs.writeFileSync(path.join(dir, 'trailhead-verify.md'), FM.replace('trailhead-verify', 'trailhead-plan') + BODY);
  ok('syncAll: a frontmatter name that differs from the file name throws',
    throws(() => syncAll({ check: true, agentsDir: dir, sourcePath: src })));
  fs.writeFileSync(path.join(dir, 'trailhead-verify.md'), FM + BODY);
  ok('syncAll: a matching name syncs and reports the drift', JSON.stringify(syncAll({ check: true, agentsDir: dir, sourcePath: src })) === JSON.stringify(['trailhead-verify.md']));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- FAMILIES ------------------------------------------------------------------
ok('every agent file is mapped to a family', agentNames.every((n) => typeof FAMILIES[n] === 'string'));
ok('every mapped agent has a file', Object.keys(FAMILIES).every((n) => agentNames.includes(n)));
ok('every mapped family is a known family name', Object.values(FAMILIES).every((f) => FAMILY_NAMES.includes(f)));
ok('family mapping matches the design',
  FAMILIES['trailhead-verify'] === 'reviewing' && FAMILIES['trailhead-code-review'] === 'reviewing' &&
  FAMILIES['trailhead-executor'] === 'implementing' && FAMILIES['trailhead-fix'] === 'implementing' &&
  FAMILIES['trailhead-debug'] === 'investigating' && FAMILIES['trailhead-research'] === 'investigating' &&
  FAMILIES['trailhead-codebase-map'] === 'investigating' && FAMILIES['trailhead-plan'] === 'plan');

// --- the real source and agents ------------------------------------------------
ok('source defines the common block', typeof blocks.common === 'string' && blocks.common.length > 0);
ok('common block names the full rule in _shared/techniques.md', blocks.common.includes('_shared/techniques.md'));
ok('common block no longer carries the long "in any shape" paragraph', !blocks.common.includes('in any shape'));
for (const name of agentNames) {
  const md = readAgent(name);
  ok(`${name}: has the common block markers`, md.includes(open('common')) && md.includes(close('common')));
  ok(`${name}: no longer carries the long "in any shape" paragraph`, !md.includes('in any shape'));
  ok(`${name}: in sync with scripts/agent-blocks.md (run node scripts/sync-agent-blocks.js)`,
    renderAgent(md, blocks, FAMILIES[name]) === md);
  ok(`${name}: no em-dash`, !md.includes('—'));
}
ok('agent-blocks.md has no em-dash', !source.includes('—'));

// --- the reviewing block (#250): the fixed status line contract -----------------
const techDir = path.join(root, 'plugins', 'trailhead', 'skills', '_shared', 'techniques');
const techniqueTokens = (file) => {
  const text = fs.readFileSync(path.join(techDir, file), 'utf8');
  return [...new Set([...text.matchAll(/`status: (\w+)`/g)].map((m) => m[1]))].sort();
};
// The backticked words on the block's vocabulary line for one agent (before the first `;`,
// where the token list ends and the content rules begin), minus the placeholder.
const blockTokens = (agent) => {
  const line = (blocks.reviewing || '').split('\n').find((l) => l.startsWith(`- ${agent}:`)) || '';
  return [...line.split(';')[0].matchAll(/`(\w+)`/g)].map((m) => m[1]).sort();
};
const reviewing = (blocks.reviewing || '').toLowerCase();
ok('source defines the reviewing block', typeof blocks.reviewing === 'string' && blocks.reviewing.length > 0);
ok('reviewing block: the first line of the report is the status line, verbatim',
  reviewing.includes('first line') && reviewing.includes('verbatim') && reviewing.includes('`status:`'));
ok('reviewing block: verify vocabulary equals the technique tokens',
  JSON.stringify(blockTokens('trailhead-verify')) === JSON.stringify(techniqueTokens('verify.md')) &&
  techniqueTokens('verify.md').length === 3);
ok('reviewing block: code-review vocabulary equals the technique tokens',
  JSON.stringify(blockTokens('trailhead-code-review')) === JSON.stringify(techniqueTokens('code-review.md')) &&
  techniqueTokens('code-review.md').length === 2);
ok('reviewing block: code-review counts line is line 2',
  (blocks.reviewing || '').includes('critical: <n> · warning: <n> · info: <n>') && reviewing.includes('line 2'));
ok('reviewing block: returned as the final message, never posted, the orchestrator posts',
  reviewing.includes('final message') && reviewing.includes('do not post') && reviewing.includes('the orchestrator posts'));
ok('reviewing block: read-only, never commit', reviewing.includes('never edit/write') && reviewing.includes('never commit'));
for (const name of agentNames) {
  const md = readAgent(name);
  const has = md.includes(open('reviewing')) && md.includes(close('reviewing'));
  const wants = FAMILIES[name] === 'reviewing';
  ok(`${name}: ${wants ? 'carries' : 'does not carry'} the reviewing block`, has === wants);
}
for (const name of ['trailhead-verify', 'trailhead-code-review']) {
  ok(`${name}: no longer says it reports into trailhead's VERIFY comment`,
    !/reports?\b[^.\n]*into trailhead's `VERIFY` comment/i.test(readAgent(name)));
}

// --- boundaries (#248) ---
{
  const common = blocks.common || '';
  for (const needle of ['git push', 'git stash', 'git reset --hard', 'git checkout -- <path>', 'git clean -f',
    'git switch', 'gh issue', 'gh pr', 'the orchestrator posts']) {
    ok(`common block names ${needle}`, common.includes(needle));
  }
  ok('common block states the shared-checkout rule', common.includes('not yours') && common.includes('stop without touching it'));
  ok('common block does not carry the worktree recipe', !common.includes('worktree add'));
  ok('common block does not say to report `blocked`', !common.includes('report `blocked`'));
  ok('common block allows reverting only your own changes', common.includes('only on a file you changed'));
  ok('common block forbids branch creation too', common.includes('git checkout -b') && common.includes('the orchestrator sets up the branch'));

  const impl = blocks.implementing || '';
  ok('source defines the implementing block', typeof blocks.implementing === 'string' && impl.length > 0);
  for (const needle of ['mktemp -d', 'worktree add --detach', 'worktree remove', 'rev-parse HEAD', 'never stash',
    'git add -A', 'git add .', 'git commit -a', 'Refs: #<n>', 'git commit -- <path>', 'already staged',
    'inconclusive', 'in your report']) {
    ok(`implementing block names ${needle}`, impl.includes(needle));
  }
  for (const name of agentNames) {
    const md = readAgent(name);
    const has = md.includes(open('implementing')) && md.includes(close('implementing'));
    const wants = FAMILIES[name] === 'implementing';
    ok(`${name}: ${wants ? 'carries' : 'does not carry'} the implementing block`, has === wants);
    ok(`${name}: forbids git stash and tracker writes`, md.includes('git stash') && md.includes('gh issue'));
  }
  // The executor posts nothing: the Execute step hands the tracker writes to the orchestrator (#248).
  const engines = fs.readFileSync(path.join(root, 'plugins', 'trailhead', 'skills', 'trailhead-work', 'references', 'ticket-engines.md'), 'utf8');
  const engineLines = engines.split('\n');
  const execStart = engineLines.findIndex((l) => l.startsWith('3. **Execute**'));
  const execEnd = engineLines.findIndex((l, i) => i > execStart && l.startsWith('4. **Verify**'));
  const execute = execStart === -1 ? '' : engineLines.slice(execStart, execEnd === -1 ? undefined : execEnd).join('\n');
  ok('Execute step: the executor returns the fidelity list, the orchestrator posts it',
    execute.includes('returns the enumerated fidelity list in its report') && execute.includes('the orchestrator posts it as a ticket comment'));
  ok('Execute step: under `git: pr` the orchestrator creates the branch and opens the PR',
    execute.includes('the orchestrator creates the branch before the spawn and opens the PR'));
}

// --- the return contracts of the implementing, investigating and plan blocks (#249) ---
{
  // Backticked words of the block bullet `- <prefix>:`; null when the bullet is absent.
  const bullet = (block, prefix) => {
    const line = (block || '').split('\n').find((l) => l.startsWith(`- ${prefix}:`));
    return line === undefined ? null : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  };
  const contracts = {
    implementing: { statuses: ['done', 'partial', 'blocked'], required: ['commits', 'tests', 'deviations', 'blockers'],
      optional: ['fidelity', 'surfaced scope'] },
    investigating: { statuses: ['found', 'inconclusive', 'needs_input'], required: ['answer', 'evidence', 'open questions'], optional: [] },
    plan: { statuses: ['ready', 'needs_input'], required: [], optional: ['questions'] },
  };
  for (const [family, want] of Object.entries(contracts)) {
    const block = blocks[family] || '';
    const lc = block.toLowerCase();
    ok(`${family} block: defined`, block.length > 0);
    ok(`${family} block: returned as the final message, never posted`,
      lc.includes('final message') && lc.includes('do not post') && lc.includes('the orchestrator posts'));
    ok(`${family} block: line 1 is the status line, verbatim`,
      lc.includes('first line') && lc.includes('verbatim') && block.includes('`status: <token>`'));
    ok(`${family} block: statuses`, JSON.stringify(bullet(block, 'statuses')) === JSON.stringify(want.statuses));
    ok(`${family} block: required fields`, JSON.stringify(bullet(block, 'required fields')) === JSON.stringify(want.required));
    ok(`${family} block: optional fields`, JSON.stringify(bullet(block, 'optional fields')) === JSON.stringify(want.optional));
    ok(`${family} block: states the field grammar`,
      lc.includes('top-level line') && lc.includes('next field label') && lc.includes('empty value or `none` means none'));
    ok(`${family} block: one status line only, body status text quoted or reworded`,
      lc.includes('only line starting with `status:`') && lc.includes('code fence or a blockquote, or reworded'));
    ok(`${family} block: nothing after the last field`, lc.includes('nothing after the last field'));
    ok(`${family} block: no backslash (survives the Codex TOML projection unescaped)`, !block.includes('\\'));
  }
  const inv = (family) => (blocks[family] || '').split('\n').filter((l) => l.startsWith('- invariant:'));
  ok('implementing block: done => blockers none; partial/blocked => blockers non-empty',
    JSON.stringify(inv('implementing')) === JSON.stringify([
      '- invariant: `done` => `blockers` none.',
      '- invariant: `partial`, `blocked` => `blockers` non-empty.',
    ]));
  ok('investigating block: needs_input => open questions non-empty',
    JSON.stringify(inv('investigating')) === JSON.stringify(['- invariant: `needs_input` => `open questions` non-empty.']));
  ok('plan block: ready => body non-empty; needs_input => questions non-empty',
    JSON.stringify(inv('plan')) === JSON.stringify([
      '- invariant: `ready` => `body` non-empty.',
      '- invariant: `needs_input` => `questions` non-empty.',
    ]));
  ok('implementing block: a blank line between Commits and Return contract', (blocks.implementing || '').includes('trailer.\n\n**Return contract.**'));
  const impl = blocks.implementing || '';
  for (const needle of ['`<sha> <subject>`', 'exact install command', 'infeasible', 'foreign change', '`fidelity`', 'mockup was passed',
    '`surfaced scope`', 'Refs: #<n>', 'since the base']) {
    ok(`implementing return contract names ${needle}`, impl.includes(needle));
  }
  const inves = blocks.investigating || '';
  ok('investigating block: never commits, never creates or switches a branch',
    inves.includes('Never commit') && inves.includes('branch'));
  ok('investigating block: evidence is file:line and URLs', inves.includes('file:line') && inves.includes('URL'));
  const planBlock = blocks.plan || '';
  ok('plan block: the rest of the report is the PLAN, never commits',
    planBlock.includes('rest of the report is the PLAN') && planBlock.includes('Never commit'));
  for (const name of agentNames) {
    const md = readAgent(name);
    for (const family of Object.keys(contracts)) {
      const has = md.includes(open(family)) && md.includes(close(family));
      ok(`${name}: ${FAMILIES[name] === family ? 'carries' : 'does not carry'} the ${family} block`, has === (FAMILIES[name] === family));
    }
  }
}

console.log(`sync-agent-blocks.test.js: ${passed} checks passed`);
