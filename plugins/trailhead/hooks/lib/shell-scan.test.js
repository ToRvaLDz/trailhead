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

// --- heredocs: a `<<` with shell context (#212) ---
{
  // Each is followed by a newline and `cat .env`, which must stay visible.
  const notHeredoc = [
    'echo $((1<<3))', 'x=$(( y << 2 ))', 'echo $[1<<3]', '((x=1<<3))',
    'echo "a <<EOF b"', "echo '<<EOF'", '# <<EOF', 'echo hi # <<EOF',
    'echo \\<<EOF', 'cat <<<x', 'echo "${#x}" <<<EOF', 'echo $((1\n<<3))',
    "echo $'a\\'b <<EOF'", 'x=abc; echo ${x#<<EOF}', 'echo ${x:-<<EOF}', 'echo "${x:-<<EOF}"', 'echo ${x:-"}" <<EOF}',
  ];
  for (const c of notHeredoc) {
    const full = `${c}\ncat .env`;
    ok(`not a heredoc: ${JSON.stringify(c)}`,
      stripHeredocBodies(full) === full && countHeredocs(c) === 0 && heredocBodies(full).length === 0 &&
      splitStatements(full).includes('cat .env'));
  }
  ok('a quoted string spanning lines suppresses an introducer on the next line',
    stripHeredocBodies('echo "start\n<<EOF\nend"\ncat .env') === 'echo "start\n<<EOF\nend"\ncat .env' &&
    heredocBodies('echo "start\n<<EOF\nend"\ncat .env').length === 0);
  ok('a single-quoted string spanning lines suppresses an introducer too',
    stripHeredocBodies("echo 'a\n<<EOF\nb'\ncat .env") === "echo 'a\n<<EOF\nb'\ncat .env");
  ok('# mid-word is not a comment, so the heredoc after it is real',
    stripHeredocBodies('a#b <<EOF\nx\nEOF\ncat .env') === 'a#b <<EOF\ncat .env');
  ok('let x=1<<3 is a heredoc with tag 3',
    stripHeredocBodies('let x=1<<3\nbody\n3\ncat .env') === 'let x=1<<3\ncat .env');
  ok('a heredoc inside $(...) is still found',
    stripHeredocBodies('x=$(cat <<EOF\nbody\nEOF\n)\ncat .env') === 'x=$(cat <<EOF\n)\ncat .env');
  ok('quoted tags and <<- keep working',
    stripHeredocBodies("cat <<'E'\na\nE\ncat <<\"F\"\nb\nF\ncat <<-G\n\tc\n\tG\nz") === "cat <<'E'\ncat <<\"F\"\ncat <<-G\nz");
  ok('an ANSI-C string closes on its own quote, so a heredoc after it is real',
    stripHeredocBodies("echo $'a\\'b' <<EOF\nx\nEOF\ncat .env") === "echo $'a\\'b' <<EOF\ncat .env" &&
    stripHeredocBodies('echo ${x} <<EOF\nx\nEOF\ncat .env') === 'echo ${x} <<EOF\ncat .env');
  const cont = 'true <<EOF \\\n; echo REACHED\nbody\nEOF\ncat .env';
  ok('a backslash-newline joins the lines: the continuation stays visible, the body starts after it',
    stripHeredocBodies(cont) === 'true <<EOF \\\n; echo REACHED\ncat .env' && heredocBodies(cont)[0].body === 'body' &&
    JSON.stringify(splitStatements(cont)) === JSON.stringify(['true <<EOF \\', 'echo REACHED', 'cat .env']));
  ok('an escaped space is not a word boundary, so \\ #x <<EOF is a real heredoc',
    stripHeredocBodies('echo \\ #x <<EOF\nx\nEOF\ncat .env') === 'echo \\ #x <<EOF\ncat .env' &&
    countHeredocs('echo \\ #x <<EOF') === 1);
  ok('a comment ending in a backslash does not continue', stripHeredocBodies('echo hi # <<A \\\n<<EOF\nx\nEOF\ncat .env') === 'echo hi # <<A \\\n<<EOF\ncat .env');
  ok('countHeredocs ignores a quoted or arithmetic << but counts a real one',
    countHeredocs('echo "<<A" $((1<<2)) <<B') === 1);
}

// --- heredocs: splitters and the scanner share one context model (#212) ---
// secret-guard pairs heredocBodies with per-statement countHeredocs by position,
// so the two must agree even when a separator sits inside $((..)), a comment, etc.
{
  const agree = (c) => heredocBodies(c).length === splitStatements(c).reduce((n, t) => n + countHeredocs(t), 0) &&
    heredocBodies(c).length === splitStatementsWithSeparators(c).reduce((n, x) => n + countHeredocs(x.text), 0);
  const body = "bash <<'EOF'\ngh issue comment 1 --body hi\nEOF";
  for (const first of [
    'echo $((1|2<<3))', 'echo $((1&&2<<3))', 'echo $((1||2<<3))', 'echo $((1;2<<3))', 'echo $[1|2<<3]',
    '((x=1|2<<3))', ': # ;true <<A', ': # |true <<A', 'echo ${x:-a;b <<A}', 'echo ok',
  ]) ok(`heredocBodies agrees with countHeredocs per statement: ${JSON.stringify(first)}`, agree(`${first}\n${body}`));
  ok('splitStatements does not cut inside $((..)), $[..] or a comment',
    JSON.stringify(splitStatements('echo $((1|2)) $[3;4] # a;b\nls')) === JSON.stringify(['echo $((1|2)) $[3;4] # a;b', 'ls']));
}

// --- a newline inside an open quote is not a statement boundary (#212) ---
{
  const one = (c) => splitStatements(c).length === 1 && splitStatementsWithSeparators(c).length === 1;
  ok('a multi-line double-quoted commit message stays one statement',
    one('git commit -m "fix\n\nrun:\ncat .env\nmore"'));
  ok('a multi-line single-quoted string stays one statement', one("echo 'a\ncat .env\nb'"));
  ok('a multi-line ANSI-C string stays one statement', one("echo $'a\ncat .env\nb'"));
  ok('a multi-line ${..} stays one statement', one('echo ${x:-a\ncat .env\nb}'));
  const agree = (c) => heredocBodies(c).length === splitStatements(c).reduce((n, t) => n + countHeredocs(t), 0) &&
    heredocBodies(c).length === splitStatementsWithSeparators(c).reduce((n, x) => n + countHeredocs(x.text), 0);
  for (const c of ['echo "a\n<<3\nb"\ncat .env', "echo 'a\n<<EOF\nb'\ncat .env", 'echo "a\n<<EOF\nb" <<EOF\nx\nEOF\ncat .env'])
    ok(`heredoc counts agree across a quoted newline: ${JSON.stringify(c)}`, agree(c));
}

// --- a continuation line starts a word only if the text before the backslash ended one (#212) ---
{
  const plain = (c) => heredocBodies(c).length === 0 && stripHeredocBodies(c) === c;
  ok('echo a \\<nl># is a comment, so its << is no heredoc', plain('echo a \\\n# x <<EOF\ncat .env\nEOF'));
  ok('echo a\\<nl># is a word, not a comment, so the << is a heredoc',
    stripHeredocBodies('echo a\\\n# x <<EOF\nx\nEOF\ncat .env') === 'echo a\\\n# x <<EOF\ncat .env');
  ok('a lone backslash line keeps the earlier boundary', plain('echo a \\\n\\\n# x <<EOF\ncat .env\nEOF'));
  ok('an escaped space before the backslash is not a boundary',
    countHeredocs('echo a\\ \\\n# x <<EOF') === 1);
}

// --- a # glued to the ) of an expansion is not a comment (#212) ---
{
  const J = JSON.stringify;
  ok('$(..)# keeps splitting: bash runs the later statement',
    J(splitStatements('$(echo b)# cm ; echo MARK')) === J(['$(echo b)# cm', 'echo MARK']));
  ok('<(..)# keeps splitting on a background &',
    J(splitStatementsWithSeparators('cat <(echo z)# cm & echo MARK').map((x) => x.text)) === J(['cat <(echo z)# cm', 'echo MARK']));
  ok('>(..)# and $((..))# keep splitting',
    J(splitStatements('tee >(cat)# c ; echo MARK')) === J(['tee >(cat)# c', 'echo MARK']) &&
    J(splitStatements('echo $((1+2))# c ; echo MARK')) === J(['echo $((1+2))# c', 'echo MARK']));
  ok('a # after a plain subshell or group is still a comment',
    J(splitStatements('(echo b)# cm ; echo NOMARK')) === J(['(echo b)# cm ; echo NOMARK']) &&
    J(splitStatements('((x=1))# cm ; echo NOMARK')) === J(['((x=1))# cm ; echo NOMARK']));
  ok('$(..)# glued word: a later << is a real heredoc, a comment one is not',
    countHeredocs('cat $(echo b)# <<EOF') === 1 && countHeredocs('(echo b)# <<EOF') === 0);
  ok('a process substitution separator splits inside it', J(splitStatements('cat <(a; b)')) === J(['cat <(a', 'b)']));
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
