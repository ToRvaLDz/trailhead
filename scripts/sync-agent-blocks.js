#!/usr/bin/env node
'use strict';
// Sync the shared agent blocks from scripts/agent-blocks.md into the agents under
// plugins/trailhead/agents/. #250.
//
// CLI:
//   node scripts/sync-agent-blocks.js            rewrite the agents that differ
//   node scripts/sync-agent-blocks.js --check    write nothing; exit 1 listing the
//                                                agents that differ from the source
//
// A block is the text between `<!-- trailhead:agent-block <name> -->` and
// `<!-- /trailhead:agent-block <name> -->`, in the source and in each agent.
// renderAgent() replaces the content between markers an agent already has and
// appends the missing ones at the end of its body, `common` first, then its
// family's block. The frontmatter is never touched. Idempotent.

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, 'agent-blocks.md');
const AGENTS_DIR = path.resolve(__dirname, '..', 'plugins', 'trailhead', 'agents');

const FAMILY_NAMES = Object.freeze(['reviewing', 'implementing', 'investigating', 'plan', 'grilling']);

// Agent name -> family. A family with no block in the source gets `common` only.
const FAMILIES = Object.freeze({
  'trailhead-verify': 'reviewing',
  'trailhead-code-review': 'reviewing',
  'trailhead-executor': 'implementing',
  'trailhead-fix': 'implementing',
  'trailhead-debug': 'investigating',
  'trailhead-research': 'investigating',
  'trailhead-codebase-map': 'investigating',
  'trailhead-plan': 'plan',
  'trailhead-grill': 'grilling',
});

const openMarker = (name) => `<!-- trailhead:agent-block ${name} -->`;
const closeMarker = (name) => `<!-- /trailhead:agent-block ${name} -->`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Source text -> { name: content }, content trimmed of surrounding blank lines.
// An unclosed or duplicated block throws.
function parseSource(text) {
  const blocks = {};
  const openRe = /<!-- trailhead:agent-block ([\w-]+) -->/g;
  let m;
  while ((m = openRe.exec(text)) !== null) {
    const name = m[1];
    if (Object.prototype.hasOwnProperty.call(blocks, name)) throw new Error(`duplicate agent block: ${name}`);
    const start = m.index + m[0].length;
    const end = text.indexOf(closeMarker(name), start);
    if (end === -1) throw new Error(`unclosed agent block: ${name}`);
    blocks[name] = text.slice(start, end).replace(/^\s*\n/, '').replace(/\s+$/, '');
    openRe.lastIndex = end + closeMarker(name).length;
  }
  return blocks;
}

function agentName(md) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const m = fm && /^name:[ \t]*(\S+)[ \t]*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

// Every marker name in the agent must be a single open followed by a single close
// (or absent): anything else would sync only the first pair or append a duplicate.
function assertBalanced(md) {
  const seen = {};
  const re = /<!-- (\/?)trailhead:agent-block ([\w-]+) -->/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const rec = seen[m[2]] || (seen[m[2]] = []);
    rec.push(m[1] ? 'close' : 'open');
  }
  for (const [name, kinds] of Object.entries(seen)) {
    if (kinds.length !== 2 || kinds[0] !== 'open' || kinds[1] !== 'close') {
      throw new Error(`unbalanced agent block markers for ${name}: ${kinds.join(', ')}`);
    }
  }
}

const wrap = (name, content) => `${openMarker(name)}\n${content}\n${closeMarker(name)}`;

// Returns the agent text with `common` and the family's block in sync with `blocks`.
function renderAgent(md, blocks, family) {
  const name = agentName(md);
  if (!name || !Object.prototype.hasOwnProperty.call(FAMILIES, name)) throw new Error(`unknown agent: ${name}`);
  if (!FAMILY_NAMES.includes(family)) throw new Error(`unknown family: ${family}`);
  if (typeof blocks.common !== 'string') throw new Error('the source has no common block');
  assertBalanced(md);

  const wanted = ['common', family].filter((n, i, a) => a.indexOf(n) === i && typeof blocks[n] === 'string');
  let out = md;
  for (const n of wanted) {
    const re = new RegExp(`${escapeRe(openMarker(n))}[\\s\\S]*?${escapeRe(closeMarker(n))}`);
    if (re.test(out)) {
      out = out.replace(re, () => wrap(n, blocks[n]));
    } else {
      out = `${out.replace(/\s+$/, '')}\n\n${wrap(n, blocks[n])}\n`;
    }
  }
  return out;
}

// Plan which agents differ from the source; write them unless `check`.
function syncAll({ check = false, agentsDir = AGENTS_DIR, sourcePath = SOURCE_PATH } = {}) {
  const blocks = parseSource(fs.readFileSync(sourcePath, 'utf8'));
  const drifted = [];
  for (const file of fs.readdirSync(agentsDir).filter((f) => /^trailhead-.*\.md$/.test(f)).sort()) {
    const full = path.join(agentsDir, file);
    const md = fs.readFileSync(full, 'utf8');
    const name = file.slice(0, -3);
    if (!Object.prototype.hasOwnProperty.call(FAMILIES, name)) throw new Error(`unknown agent: ${name}`);
    if (agentName(md) !== name) throw new Error(`${file}: frontmatter name is ${agentName(md)}, expected ${name}`);
    const next = renderAgent(md, blocks, FAMILIES[name]);
    if (next === md) continue;
    drifted.push(file);
    if (!check) fs.writeFileSync(full, next);
  }
  return drifted;
}

function main(argv, out = process.stdout, err = process.stderr) {
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length) {
    err.write(`usage: sync-agent-blocks.js [--check] (unknown argument: ${unknown[0]})\n`);
    return 2;
  }
  const check = argv.includes('--check');
  let drifted;
  try {
    drifted = syncAll({ check });
  } catch (e) {
    err.write(`sync-agent-blocks: ${e.message}\n`);
    return 2;
  }
  if (check) {
    if (drifted.length === 0) return 0;
    err.write(`agents out of sync with scripts/agent-blocks.md:\n${drifted.map((f) => `  ${f}`).join('\n')}\n`);
    return 1;
  }
  out.write(drifted.length ? `updated:\n${drifted.map((f) => `  ${f}`).join('\n')}\n` : 'agents already in sync\n');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseSource, renderAgent, syncAll, main, FAMILIES, FAMILY_NAMES };
