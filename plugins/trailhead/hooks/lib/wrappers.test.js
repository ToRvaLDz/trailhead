#!/usr/bin/env node
// Tests for wrappers.js. Run: node wrappers.test.js
const assert = require('assert');
const { WRAPPER_FLAGS, COMMAND_WRAPPERS, INSTALL_WRAPPERS, isWrapper, flagValue, flagWidth, isSplitFlag, isLookupFlag, skipWrapperFlags } = require('./wrappers.js');

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

// named peel sets (I1, W2)
for (const w of ['ionice', 'stdbuf', 'builtin', 'doas', 'env', 'sudo', 'timeout', 'nice', 'nohup', 'exec', 'command']) ok(`${w} is in the command peel set`, COMMAND_WRAPPERS.has(w));
ok('xargs and time are not in the command peel set', !COMMAND_WRAPPERS.has('xargs') && !COMMAND_WRAPPERS.has('time'));
ok('the install set peels xargs and time but not builtin', INSTALL_WRAPPERS.has('xargs') && INSTALL_WRAPPERS.has('time') && !INSTALL_WRAPPERS.has('builtin'));
// ionice -P / -u (I2); -t is a boolean
for (const f of ['-P', '-u', '-c', '-n', '-p']) ok(`ionice takes a value after ${f}`, WRAPPER_FLAGS.ionice.has(f));
ok('ionice -t takes no value', !WRAPPER_FLAGS.ionice.has('-t'));

// skipWrapperFlags (I3)
const dq = (t) => String(t).replace(/^(['"])([\s\S]*)\1$/, '$2');
const tk = (p) => String(p).split(/\s+/).filter(Boolean);
const o = { norm: dq, tokenize: (p) => tk(dq(p)), assign: /^[A-Za-z_]\w*=/ };
const skip = (toks, k = 0, opts = o) => { const r = skipWrapperFlags(toks, k, opts); return r.toks.slice(r.next); };
eq('plain flags and a value', skip(['sudo', '-u', 'root', 'gh', 'x']), ['gh', 'x']);
eq('-- ends the wrapper options', skip(['env', '--', '-u', 'x']), ['-u', 'x']);
eq('-- then an assignment', skip(['env', '--', 'A=1', 'gh']), ['gh']);
eq('env assignments', skip(['env', 'A=1', 'B=2', 'gh']), ['gh']);
eq('timeout DURATION', skip(['timeout', '-s', 'KILL', '5', 'gh']), ['gh']);
eq('timeout -- DURATION', skip(['timeout', '--', '5', 'gh']), ['gh']);
eq('a quoted flag is the same flag', skip(['sudo', "'-u'", 'root', 'gh']), ['gh']);
eq('env -S payload is re-tokenized', skip(['env', '-S', "'gh issue comment 1'", 'tail']), ['gh', 'issue', 'comment', '1', 'tail']);
eq('env -iS payload', skip(['env', '-iS', "'gh issue'"]), ['gh', 'issue']);
eq('env -S attached payload', skip(['env', '-Sgh issue']), ['gh', 'issue']);
eq('env --split-string=payload', skip(['env', '--split-string=gh issue']), ['gh', 'issue']);
eq('env --split-string payload', skip(['env', '--split-string', "'gh issue'"]), ['gh', 'issue']);
eq('env -u S is a value, not a split', skip(['env', '-u', 'S', 'gh']), ['gh']);
eq('the prefix before the wrapper is kept', skipWrapperFlags(['A=1', 'env', '-S', "'gh x'"], 1, o).toks.slice(0, 1), ['A=1']);
eq('command -v is a lookup when asked', skipWrapperFlags(['command', '-v', 'gh'], 0, { ...o, lookup: true }).next, 3);
eq('command -v is not special by default', skip(['command', '-v', 'gh']), ['gh']);

console.log(`wrappers: ${passed} assertions passed`);
