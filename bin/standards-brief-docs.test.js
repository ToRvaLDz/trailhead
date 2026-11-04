#!/usr/bin/env node
// Docs test for #359: before a code review the orchestrator lists the repo's
// standards files, the brief carries the paths, and the reviewer reads them and
// cites the file for each standards finding.
// Run: node standards-brief-docs.test.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const skills = path.join(root, 'plugins', 'trailhead', 'skills');
const agents = path.join(root, 'plugins', 'trailhead', 'agents');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const review = read(skills, '_shared', 'techniques', 'code-review.md');
const techniques = read(skills, '_shared', 'techniques.md');
const agent = read(agents, 'trailhead-code-review.md');

const lines = review.split('\n');
const route = lines.find((l) => l.startsWith('**First, route it.**')) || '';
const paraStart = lines.findIndex((l) => l.startsWith('**Standards files: list them before the review.**'));
const axesIdx = lines.indexOf('Review on five axes:');
const ticketDiffIdx = lines.findIndex((l) => l.startsWith('**Ticket diff:'));
const section = paraStart >= 0 ? lines.slice(paraStart, axesIdx).join('\n') : '';
const axis = lines.find((l) => l.startsWith('- **Standards & spec**')) || '';

// The brief: the spawn prompt carries the list, paths only.
ok('route: spawn prompt carries the standards files line', route.includes('`standards files: <list>`'));
ok('route: points at the listing', route.includes('**Standards files**'));

// The listing.
ok('section exists', section.length > 0);
ok('section sits after Ticket diff and before the axes', ticketDiffIdx >= 0 && paraStart > ticketDiffIdx && axesIdx > paraStart);
ok('axes count unchanged', review.includes('Review on five axes:'));

const command = (section.match(/```\n(git -C <repo> ls-files [^\n]+)\n```/) || [])[1] || '';
ok('section gives the exact listing command', command.length > 0);
for (const pattern of [
  'CONTRIBUTING*', 'CODING_STANDARDS*', 'AGENTS.md', 'CLAUDE.md', '.editorconfig', '.eslintrc*', 'eslint.config.*',
  '.prettierrc*', 'prettier.config.*', 'biome.json*', 'ruff.toml', 'pyproject.toml', '.golangci.*', 'rustfmt.toml',
]) {
  ok(`command matches ${pattern} at any depth`, command.includes(`**/${pattern}'`));
}
ok('CONTRIBUTING matches in any case', command.includes("':(glob,icase)**/CONTRIBUTING*'"));

for (const sub of [
  'trailhead:conventions',
  '**Find a singleton issue** in `../substrate-commands.md`',
  'the paths only, never their contents',
  '`standards files: none`',
  'Recompute the list on every review round',
  'gh issue view <n> --json body',
  'cites the file',
  'not a standards finding',
  'what tooling already enforces',
  '**Review adversarially**',
  'never a correctness or security finding',
  'runs the same listing itself',
  'on every pass including the lean inline one',
]) {
  ok(`section: ${sub}`, section.includes(sub));
}

// The axis and the pointers.
ok('axis: reads the listed files', axis.includes('**Standards files**'));
ok('axis: cites the file', axis.includes('cite the file'));
ok('techniques.md: row names the listing', techniques.includes("the brief lists the repo's standards files"));
ok('techniques.md: 5 axes kept', techniques.includes('on 5 axes'));
ok('agent: reads the files the spawn names and cites them',
  agent.includes('the repo\'s standards files, at the paths the spawn names') && agent.includes('cite the file'));

// The command does what it says on a real repo.
if (command) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standards-brief-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    const wanted = [
      'CONTRIBUTING.md', '.github/contributing.md', 'CODING_STANDARDS.md', 'AGENTS.md', 'pkg/a/CLAUDE.md',
      '.editorconfig', 'eslint.config.mjs', 'pkg/b/.prettierrc.json', 'pyproject.toml',
    ];
    const unwanted = ['README.md', 'src/index.js', 'docs/AGENTS.txt'];
    for (const f of [...wanted, ...unwanted, 'ignored/CLAUDE.md']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'x\n');
    }
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
    git('add', '-A');
    const out = execFileSync('sh', ['-c', command.replace('<repo>', `'${dir}'`)], { encoding: 'utf8' })
      .split('\n').filter(Boolean).sort();
    assert.deepStrictEqual(out, [...wanted].sort(), 'listing finds exactly the tracked standards files');
    passed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, text] of Object.entries({
  'code-review.md': review,
  'techniques.md': techniques,
  'trailhead-code-review.md': agent,
  'standards-brief-docs.test.js': read(__dirname, 'standards-brief-docs.test.js'),
})) {
  ok(`${name} has no em-dash`, !text.includes(String.fromCharCode(0x2014)));
}

console.log(`standards-brief-docs.test.js: ${passed} checks passed`);
