#!/usr/bin/env node
// Test di lib/git-globals.js. Run: node git-globals.test.js
const assert = require('assert');
const g = require('./git-globals.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

for (const o of ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']) {
  ok(`${o} takes a separate value`, g.takesSeparateValue(o) && g.GIT_GLOBAL_VALUE_OPTIONS.has(o));
}
ok('--opt=value consumes nothing', !g.takesSeparateValue('--config-env=core.x=V'));
ok('a bare flag takes no value', !g.takesSeparateValue('--no-pager') && g.GIT_GLOBAL_FLAGS.has('--no-pager'));
ok('--exec-path is an eq-flag, never a separate value', g.GIT_GLOBAL_EQ_FLAGS.has('--exec-path') && !g.takesSeparateValue('--exec-path'));
ok('the sets are frozen', Object.isFrozen(g.GIT_GLOBAL_VALUE_OPTIONS) && Object.isFrozen(g.GIT_GLOBAL_FLAGS) && Object.isFrozen(g.GIT_GLOBAL_EQ_FLAGS));

console.log(`✓ git-globals: ${passed} assertions passed`);
