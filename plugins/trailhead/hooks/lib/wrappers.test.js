#!/usr/bin/env node
// Tests for wrappers.js. Run: node wrappers.test.js
const assert = require('assert');
const { WRAPPER_FLAGS, isWrapper, flagValue, flagWidth, isSplitFlag, isLookupFlag } = require('./wrappers.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b); passed++; };

ok('doas is a wrapper', isWrapper('doas'));
ok('only own keys count', !isWrapper('constructor') && !isWrapper('gh') && !isWrapper('toString'));
for (const w of ['sudo', 'doas', 'env', 'nice', 'ionice', 'timeout', 'stdbuf', 'exec', 'command', 'builtin', 'nohup', 'time', 'setsid', 'xargs']) {
  ok(`${w} is in the table`, isWrapper(w));
}
const sudo = WRAPPER_FLAGS.sudo;
for (const f of ['-u', '--user', '-a', '--auth-type', '-c', '--login-class', '-T', '--command-timeout', '-g', '-D', '-R']) ok(`sudo takes a value after ${f}`, sudo.has(f));
for (const f of ['-a', '-C', '-u']) ok(`doas takes a value after ${f}`, WRAPPER_FLAGS.doas.has(f));

// getopt-style reading
const fv = (f, w) => flagValue(f, WRAPPER_FLAGS[w]);
eq('detached short', fv('-u', 'doas'), { next: true });
eq('attached short', fv('-uroot', 'doas'), { attached: 'root' });
eq('cluster, value letter last', fv('-Hu', 'sudo'), { next: true });
eq('cluster, value letter first ends it', fv('-Huroot', 'sudo'), { attached: 'root' });
eq('boolean short', fv('-E', 'sudo'), {});
eq('long with a separate value', fv('--user', 'sudo'), { next: true });
eq('long with =', fv('--user=root', 'sudo'), { attached: 'root' });
eq('boolean long', fv('--preserve-env', 'sudo'), {});
eq('a bare double dash', fv('--', 'sudo'), {});
eq('a negative nice adjustment is no value', fv('-5', 'nice'), {});

eq('flagWidth: detached is 2 tokens', flagWidth('-a', 'sudo'), 2);
eq('flagWidth: attached is 1 token', flagWidth('-astyle', 'sudo'), 1);
eq('flagWidth: unknown wrapper is 1', flagWidth('-a', 'gh'), 1);

ok('env -S is a split flag', isSplitFlag('-S') && isSplitFlag('-iS') && isSplitFlag('--split-string=x') && isSplitFlag('--split-string'));
ok('env -uS is not (S is a value)', !isSplitFlag('-uS') && !isSplitFlag('-i'));
ok('command -v / -pv are lookups', isLookupFlag('-v') && isLookupFlag('-pv') && isLookupFlag('-V'));
ok('command -p and long flags are not', !isLookupFlag('-p') && !isLookupFlag('--verbose'));

console.log(`wrappers: ${passed} assertions passed`);
