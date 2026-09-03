#!/usr/bin/env node
// Tests for shell-scan.js. Run: node shell-scan.test.js
const assert = require('assert');
const {
  basename,
  stripQuotes,
  splitStatements,
  tokenize,
  scanArgsSkippingPattern,
  SEARCH_VERB_CONFIG,
} = require('./shell-scan.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// --- basename ---
ok('basename strips leading dirs', basename('a/b/.env') === '.env');
ok('basename passes through a bare name', basename('.env') === '.env');

// --- stripQuotes ---
ok('stripQuotes unwraps a double-quoted token', stripQuotes('".env"') === '.env');
ok('stripQuotes unwraps a single-quoted token', stripQuotes("'.env'") === '.env');
ok('stripQuotes leaves a bare token alone', stripQuotes('.env') === '.env');

// --- splitStatements: glued metacharacters (no surrounding whitespace) ---
ok('splitStatements splits a glued pipe', JSON.stringify(splitStatements('cat .env|grep KEY')) === JSON.stringify(['cat .env', 'grep KEY']));
ok('splitStatements splits a glued semicolon', JSON.stringify(splitStatements('cat .env;echo done')) === JSON.stringify(['cat .env', 'echo done']));
ok('splitStatements splits a glued &&', JSON.stringify(splitStatements('cat .env&&echo done')) === JSON.stringify(['cat .env', 'echo done']));
ok('splitStatements keeps a quoted separator intact', JSON.stringify(splitStatements('grep "a;b" f.txt')) === JSON.stringify(['grep "a;b" f.txt']));

// --- tokenize: quoted multi-word phrase stays ONE token ---
ok('tokenize keeps a multi-word double-quoted phrase as one token',
  JSON.stringify(tokenize('git commit -m "document .env usage"')) ===
  JSON.stringify(['git', 'commit', '-m', '"document .env usage"']));
ok('tokenize keeps a multi-word single-quoted phrase as one token',
  JSON.stringify(tokenize("echo 'a b c'")) === JSON.stringify(['echo', "'a b c'"]));
ok('tokenize round-trips a lone quoted path via stripQuotes',
  stripQuotes(tokenize('cat ".env"')[1]) === '.env');
ok('tokenize handles an escaped quote inside a double-quoted span without closing early',
  JSON.stringify(tokenize('grep "a\\"b" f.txt')) === JSON.stringify(['grep', '"a\\"b"', 'f.txt']));

// --- scanArgsSkippingPattern: search-verb pattern-positional skipping ---
const isDotEnv = (t) => stripQuotes(t) === '.env';
ok('scanArgsSkippingPattern skips the pattern positional (grep ".env" config.txt allows)',
  scanArgsSkippingPattern(['".env"', 'config.txt'], SEARCH_VERB_CONFIG.grep, isDotEnv) === null);
ok('scanArgsSkippingPattern still finds a secret FILE operand after the pattern',
  scanArgsSkippingPattern(['-n', 'KEY', '.env'], SEARCH_VERB_CONFIG.grep, isDotEnv) === '.env');

console.log(`✓ shell-scan: ${passed} assertions passed`);
