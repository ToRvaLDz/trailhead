#!/usr/bin/env node
// Docs test: il lookup di <templates> negli skill rispetta CLAUDE_CONFIG_DIR (npm install),
// quindi nessun percorso nudo ~/.claude/trailhead/templates; il candidato Codex resta.
// Plain asserts, no framework. Run: node bin/config-dir-templates-docs.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SKILLS = path.join(root, 'plugins/trailhead/skills');
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk(SKILLS).filter((f) => f.endsWith('.md'));

const BARE = /(?<!\$\{CLAUDE_CONFIG_DIR:-)~\/\.claude\/trailhead\/templates/g;
const GOOD = '${CLAUDE_CONFIG_DIR:-~/.claude}/trailhead/templates/';
const CODEX = '~/.codex/skills/trailhead/templates/';

for (const f of files) {
  const rel = path.relative(root, f);
  ok(`${rel}: no bare ~/.claude/trailhead/templates`, !(fs.readFileSync(f, 'utf8').match(BARE)));
}

// Siti noti: candidato Claude con CLAUDE_CONFIG_DIR, candidato Codex intatto
for (const rel of [
  'trailhead-work/SKILL.md',
  '_shared/techniques.md',
  '_shared/teamwork.md',
  'trailhead-manage/references/auditing.md',
]) {
  const t = fs.readFileSync(path.join(SKILLS, rel), 'utf8');
  ok(`${rel}: config-dir candidate present`, t.includes(GOOD));
  ok(`${rel}: codex candidate untouched`, t.includes(CODEX));
}
const cfg = fs.readFileSync(path.join(SKILLS, '_shared/configuration-reference.md'), 'utf8');
ok('configuration-reference: statusline lookup uses config dir', cfg.includes(GOOD + 'statusline-trailhead.sh'));

console.log(`config-dir-templates-docs.test.js: ${passed} checks passed`);
