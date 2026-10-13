#!/usr/bin/env node
// Repo test command: `npm test`. Runs every *.test.js under bin/ and
// plugins/trailhead/hooks/ as `node <file>`, then the mod checks
// (`claude plugin validate` and `claude plugin test`).
// Set TRAILHEAD_SKIP_MOD_CHECKS=1 to skip the mod checks when `claude` is absent.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pluginDir = path.join(root, 'plugins', 'trailhead');
const SKIP_DIRS = new Set(['node_modules', 'worktrees']);

function findTests(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...findTests(full));
    } else if (entry.name.endsWith('.test.js')) {
      found.push(full);
    }
  }
  return found.sort();
}

function hasClaude() {
  return spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
}

const results = [];
const run = (label, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  results.push({ label, status: r.status === 0 ? 'pass' : 'FAIL' });
};

const TEST_ROOTS = [path.join(root, 'bin'), path.join(pluginDir, 'hooks')];
const perRoot = TEST_ROOTS.map(findTests);
// A root with no suites means it moved or was renamed: fail rather than pass on nothing.
const emptyRoot = TEST_ROOTS.find((_, i) => perRoot[i].length === 0);
if (emptyRoot) {
  console.error(`no *.test.js found under ${path.relative(root, emptyRoot)}`);
  process.exit(1);
}
const files = perRoot.flat();
for (const f of files) {
  console.log(`\n== node ${path.relative(root, f)}`);
  run(path.relative(root, f), process.execPath, [f]);
}

if (process.env.TRAILHEAD_SKIP_MOD_CHECKS === '1') {
  console.log('\n== mod checks skipped (TRAILHEAD_SKIP_MOD_CHECKS=1)');
  results.push({ label: 'claude plugin validate', status: 'skipped' });
  results.push({ label: 'claude plugin test', status: 'skipped' });
} else if (!hasClaude()) {
  console.error('\n== `claude` is not on PATH; install it or set TRAILHEAD_SKIP_MOD_CHECKS=1');
  results.push({ label: 'claude plugin validate', status: 'FAIL' });
  results.push({ label: 'claude plugin test', status: 'FAIL' });
} else {
  console.log('\n== claude plugin validate');
  run('claude plugin validate', 'claude', ['plugin', 'validate', pluginDir]);
  console.log('\n== claude plugin test');
  run('claude plugin test', 'claude', ['plugin', 'test', pluginDir]);
}

console.log('\n== summary');
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.label}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`${results.length - failed} ok/skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
