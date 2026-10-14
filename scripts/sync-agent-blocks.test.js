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

  ok('renderAgent: unknown family throws', throws(() => renderAgent(FM + BODY, B, 'nope')));
  ok('renderAgent: unknown agent throws',
    throws(() => renderAgent(FM.replace('trailhead-verify', 'trailhead-ghost') + BODY, B, 'reviewing')));
  ok('renderAgent: missing common block in the source throws',
    throws(() => renderAgent(FM + BODY, { reviewing: 'x' }, 'reviewing')));
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

console.log(`sync-agent-blocks.test.js: ${passed} checks passed`);
