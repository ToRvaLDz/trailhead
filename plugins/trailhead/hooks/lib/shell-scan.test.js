#!/usr/bin/env node
// Tests for shell-scan.js. Run: node shell-scan.test.js
const assert = require('assert');
const {
  basename,
  stripQuotes,
  stripHeredocBodies,
  heredocBodies,
  countHeredocs,
  splitStatements,
  splitStatementsWithSeparators,
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

// --- splitStatementsWithSeparators: statements plus the operator that ended each ---
{
  const seps = (c) => JSON.stringify(splitStatementsWithSeparators(c).map((x) => [x.text, x.sep]));
  ok('withSeparators reports ; and the final null', seps('a; b') === JSON.stringify([['a', ';'], ['b', null]]));
  ok('withSeparators reports &&, ||, | and newline',
    seps('a && b || c | d\ne') === JSON.stringify([['a', '&&'], ['b', '||'], ['c', '|'], ['d', '\n'], ['e', null]]));
  ok('withSeparators treats ;; as two separators with no empty statement',
    seps('case x in a) one;; b) two;; esac') === JSON.stringify([['case x in a) one', ';'], ['b) two', ';'], ['esac', null]]));
  ok('withSeparators splits on a lone & (background)', seps('a & b') === JSON.stringify([['a', '&'], ['b', null]]));
  ok('withSeparators does not split on redirections (2>&1, &>)',
    seps('a 2>&1 | b') === JSON.stringify([['a 2>&1', '|'], ['b', null]]) &&
    seps('a &> f') === JSON.stringify([['a &> f', null]]));
  ok('withSeparators keeps a quoted separator intact', seps('grep "a;b&c" f') === JSON.stringify([['grep "a;b&c" f', null]]));
  ok('withSeparators skips heredoc bodies', seps("cat <<EOF\na; b\nEOF\nz") === JSON.stringify([['cat <<EOF', '\n'], ['z', null]]));
  ok('splitStatements is unchanged on a lone &', JSON.stringify(splitStatements('a & b')) === JSON.stringify(['a & b']));
}

// --- heredocs: a herestring (<<<) is not a heredoc; bodies are extractable ---
{
  ok('a herestring does not swallow the following lines',
    stripHeredocBodies('cat <<< "hello"\ngh issue comment 1 -F x') === 'cat <<< "hello"\ngh issue comment 1 -F x');
  ok('a herestring with a bare word does not swallow the following lines',
    stripHeredocBodies('cat <<<word\nnext line') === 'cat <<<word\nnext line');
  ok('a real heredoc is still stripped', stripHeredocBodies('cat <<EOF\nbody\nEOF\nnext') === 'cat <<EOF\nnext');
  const hb = heredocBodies("cat <<EOF | x <<'B'\nfirst $(a)\nEOF\nsecond\nB\nlast");
  ok('heredocBodies returns bodies in order with the quoting of the delimiter',
    hb.length === 2 && hb[0].body === 'first $(a)' && hb[0].quoted === false && hb[1].body === 'second' && hb[1].quoted === true);
  ok('heredocBodies handles <<- with tab-indented terminator',
    heredocBodies('cat <<-EOF\n\tx\n\tEOF\n')[0].body === '\tx');
  ok('heredocBodies ignores a herestring', heredocBodies('cat <<< "a"\nb').length === 0);
  ok('countHeredocs counts introducers in a statement',
    countHeredocs('cat <<A <<B') === 2 && countHeredocs('cat <<< x') === 0 && countHeredocs('ls') === 0);
}

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
