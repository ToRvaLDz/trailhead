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
  substitutionBodies,
  heredocSubstitutionBodies,
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
  const agree = (c) => heredocBodies(c).length === splitStatementsWithSeparators(c).reduce((n, x) => n + x.heredocs, 0);
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
  const agree = (c) => heredocBodies(c).length === splitStatementsWithSeparators(c).reduce((n, x) => n + x.heredocs, 0);
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

// --- a doubled or escaped dollar opens no ANSI-C span (#217) ---
{
  const J = JSON.stringify;
  const BS = '\\';
  ok('$$ before a quote: the quote is plain, so the later statement is split',
    J(splitStatements(`echo $$'x${BS}' ; echo ran # '`)) === J([`echo $$'x${BS}'`, 'echo ran # \'']));
  ok('an escaped $ before a quote is plain too',
    J(splitStatements(`echo ${BS}$'x${BS}' ; echo ran # '`)) === J([`echo ${BS}$'x${BS}'`, 'echo ran # \'']));
  ok('a bare $\' span still honours an escaped quote',
    splitStatements(`echo $'x${BS}' ; y' ; echo ran`).length === 2);
  ok('$$$\' opens a span (the third dollar is bare)',
    splitStatements(`echo $$$'x${BS}' ; y' ; echo ran`).length === 2);
  // A bare `$` ending a line stays bare across the backslash-newline continuation.
  ok('$ then a continued $\' is PID + plain quote: three statements',
    splitStatements(`echo $${BS}\n$'x${BS}' ; echo ran ; echo ''`).length === 3);
  ok('$ then a continued quote opens ANSI-C: one statement',
    splitStatements(`echo $${BS}\n'x${BS}' ; echo ran # '`).length === 1);
  // A doubled dollar is the PID: the brace or bracket after it is a literal char.
  ok('$${ is PID + a literal brace: three statements',
    splitStatements('echo $${ ; echo ran ; echo }').length === 3);
  ok('$$[ is PID + a literal bracket: three statements',
    splitStatements('echo $$[ ; echo ran ; echo ]').length === 3);
  ok('a continued $ then ${ is PID + a literal brace: three statements',
    splitStatements(`echo $${BS}\n${'${'} ; echo ran ; echo }`).length === 3);
  ok('$$$( is PID + a real substitution',
    splitStatements('echo $$$(echo a; echo b)').length === 2);
  ok('a bare ${x} still forms one frame', splitStatements('echo ${x:-a;b} ; echo ran').length === 2);
  ok('a bare $[1;2] still forms one frame', splitStatements('echo $[1|2] ; echo ran').length === 2);
}

// --- nested subshells and substitutions inside quotes / ${..} (#212) ---
{
  const J = JSON.stringify;
  ok('((cmd); cmd) is nested subshells, not arithmetic', J(splitStatements('((echo a); cat .env)')) === J(['((echo a)', 'cat .env)']));
  ok('$((cmd); cmd) falls back to a substitution too', J(splitStatements('x=$((echo a); cat .env)')) === J(['x=$((echo a)', 'cat .env)']));
  ok('a real ((..)) and $((..)) stay arithmetic',
    J(splitStatements('((a=(1+2)*3; b=1|2)); echo $((1|(2)))')) === J(['((a=(1+2)*3; b=1|2))', 'echo $((1|(2)))']));
  ok('$(..) inside double quotes splits its inner ;', J(splitStatements('echo "$(echo a; cat .env)"')) === J(['echo "$(echo a', 'cat .env)"']));
  ok('$(..) inside ${..} splits its inner ;', J(splitStatements('echo ${x:-$(echo a; cat .env)}')) === J(['echo ${x:-$(echo a', 'cat .env)}']));
  ok('text after a closed $(..) in dq is quoted again', splitStatements('echo "$(a) ; b"').length === 1);
}

// --- a heredoc body starts after the LOGICAL line (#212) ---
{
  const J = JSON.stringify;
  ok('a quote opened after <<E runs the heredoc body past its close',
    J(splitStatements("cat <<E 'a\nb'; cat .env\nbody\nE")) === J(["cat <<E 'a\nb'", 'cat .env']));
  ok('same with a double-quoted newline', J(splitStatements('cat <<E "a\nb"; cat .env\nbody\nE')) === J(['cat <<E "a\nb"', 'cat .env']));
  ok('same with an ANSI-C quoted newline', J(splitStatements("cat <<E $'a\nb'; cat .env\nbody\nE")) === J(["cat <<E $'a\nb'", 'cat .env']));
  ok('1<<2 is no heredoc even before a multi-line quote',
    J(splitStatements("echo 1<<2 ; echo 'a\nb'; cat .env")) === J(['echo 1<<2', "echo 'a\nb'", 'cat .env']));
  ok('an ordinary heredoc body still starts on the next line',
    J(splitStatements('cat <<E\nx; y\nE\ncat .env')) === J(['cat <<E', 'cat .env']));
  ok('the $(cat <<EOF) idiom inside "..." keeps its body on the next line',
    heredocBodies('x "$(cat <<\'EOF\'\nhi; there\nEOF\n)"; cat .env')[0].body === 'hi; there' &&
    splitStatements('x "$(cat <<\'EOF\'\nhi; there\nEOF\n)"; cat .env').pop() === 'cat .env');
}

// --- a newline inside an open $(..) keeps the logical line open for an outer heredoc (#212) ---
{
  const J = JSON.stringify;
  ok('an outer heredoc waits for a multi-line "$(..)" to close',
    J(splitStatements('cat <<E "$(true\ntrue)"; cat .env\nbody\nE')) === J(['cat <<E "$(true', 'true)"', 'cat .env']));
  ok('an outer heredoc waits for a multi-line bare $(..) to close',
    J(splitStatements('cat <<E $(true\ntrue); cat .env\nbody\nE')) === J(['cat <<E $(true', 'true)', 'cat .env']));
  ok('a heredoc inside the innermost $(..) starts its body on the next physical line',
    heredocBodies('gh issue comment 1 --body "$(cat <<\'EOF\'\nbody\nEOF\n)"; cat .env')[0].body === 'body' &&
    splitStatements('gh issue comment 1 --body "$(cat <<\'EOF\'\nbody\nEOF\n)"; cat .env').pop() === 'cat .env');
}

// --- per-statement heredoc counts pair with heredocBodies (#212) ---
{
  const J = JSON.stringify;
  const sumBoth = (c) => [
    splitStatementsWithSeparators(c).reduce((n, s) => n + s.heredocs, 0),
    splitStatementsWithSeparators(c).reduce((n, s) => n + countHeredocs(s), 0),
  ];
  const cases = [
    'echo "$(true; echo hi) <<X" ; cat <<\'EOF\'\nbody\nEOF',
    'echo "$(true; cat <<A\nb\nA\n) <<X" ; cat <<B\nz\nB',
    "cat <<E 'a\nb'; cat <<F\nbody\nE\nF",
    'echo $((1<<3)); cat <<A <<B\n1\nA\n2\nB',
  ];
  for (const c of cases) {
    const n = heredocBodies(c).length;
    ok('heredoc count pairs for ' + J(c), sumBoth(c).every((x) => x === n));
  }
  // property check over a fragment soup
  const frags = ['echo "$(true; echo hi) <<X"', 'cat <<E\nb\nE', "echo '<<Q'", 'echo $((1<<2))', 'x <<A <<B\n1\nA\n2\nB',
    'echo "$(cat <<Z\nq\nZ\n)"', 'echo "$(a; b <<Y\ny\nY\n)"', "cat <<E 'a\nb'", 'true # <<C', 'echo ${x:-$(a; b)} <<D\nd\nD'];
  const seps = [' ; ', '\n', ' && ', ' | ', ' & '];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let bad = null;
  for (let t = 0; t < 400 && !bad; t++) {
    let c = frags[rnd(frags.length)];
    for (let k = rnd(4); k > 0; k--) c += seps[rnd(seps.length)] + frags[rnd(frags.length)];
    const n = heredocBodies(c).length;
    if (!sumBoth(c).every((x) => x === n)) bad = c;
  }
  ok('heredoc count pairs over a fragment soup ' + J(bad), bad === null);
}

// --- countHeredocs on a string is a pure, standalone re-lex (#212) ---
{
  const probe = 'echo "x" <<A';
  const before = countHeredocs(probe);
  const tail = 'echo hi) <<X"'; // the tail a cut inside "$(..)" leaves; standalone it lexes to 1
  const tailBefore = countHeredocs(tail);
  splitStatements('echo "$(true; true)" <<A\nb\nA');
  splitStatementsWithSeparators('cat <<E \'a\nb\'; cat <<F\nbody\nE\nF');
  splitStatements('echo "$(true; echo hi) <<X"');
  ok('countHeredocs(string) is unchanged by unrelated splits',
    before === 1 && countHeredocs(probe) === before && tailBefore === 1 && countHeredocs(tail) === tailBefore);
  ok('countHeredocs(string) lexes the text standalone, from an empty stack',
    countHeredocs('b)" <<A') === 0 && countHeredocs('true) <<A') === 1);
  ok('countHeredocs(entry) returns its whole-scan count',
    countHeredocs(splitStatementsWithSeparators('echo "$(true; cat <<A\nb\nA\n) <<X"')[1]) === 1);
}

// --- scanning stays linear on paren-heavy input (#212) ---
{
  const time = (c) => { const t = Date.now(); splitStatements(c); return Date.now() - t; };
  const k = 16000;
  ok('nested (( ... ) y scans in linear time', time('(( '.repeat(k) + ') y'.repeat(2 * k + 2)) < 500);
  ok('a 200KB line scans quickly', time('echo (a) $((1+2)) '.repeat(10000)) < 500);
  ok('a 5000-line command scans quickly', time('echo $((1<<2)); ((a)); cat <<E\nbody\nE\n'.repeat(1700)) < 500);
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

// --- substitutionBodies: outermost command-substitution bodies (#214) ---
{
  const bodies = (c) => JSON.stringify(substitutionBodies(c));
  ok('substitutionBodies finds an unquoted $(..)', bodies('echo $(cat .env)') === JSON.stringify(['cat .env']));
  ok('substitutionBodies finds a double-quoted $(..)', bodies('echo "$(cat .env)"') === JSON.stringify(['cat .env']));
  ok('substitutionBodies keeps a ; inside the body', bodies('echo "$(true; cat .env)"') === JSON.stringify(['true; cat .env']));
  ok('substitutionBodies skips a single-quoted $(..)', bodies("echo '$(cat .env)'") === '[]');
  ok('substitutionBodies skips $((..)) arithmetic', bodies('echo "$((1+2))"') === '[]');
  ok('substitutionBodies finds a $(..) inside ${..} (it runs)', bodies('echo ${x:-$(cat .env)}') === JSON.stringify(['cat .env']));
  ok('substitutionBodies skips a literal ${..} with no substitution', bodies('echo ${x:-$HOME}') === '[]');
  ok('substitutionBodies skips a comment', bodies('echo hi # $(cat .env)') === '[]');
  ok('substitutionBodies returns only the outermost of a nest',
    bodies('echo "$(echo "$(cat .env)")"') === JSON.stringify(['echo "$(cat .env)"']));
  ok('substitutionBodies finds <(..) and >(..)', bodies('diff <(cat a) >(tee b)') === JSON.stringify(['cat a', 'tee b']));
  ok('substitutionBodies finds several siblings', bodies('echo $(a) "$(b)"') === JSON.stringify(['a', 'b']));
  ok('substitutionBodies joins a multi-line body with a newline', bodies('echo "$(\ncat .env\n)"') === JSON.stringify(['\ncat .env\n']));
  ok('substitutionBodies skips heredoc bodies', bodies('cat <<E\n$(cat .env)\nE') === '[]');
  ok('substitutionBodies returns the remainder of an unterminated body', bodies('echo "$(cat .env') === JSON.stringify(['cat .env']));
  ok('substitutionBodies is empty for plain text', bodies('echo hi') === '[]');
  // W2: a heredoc inside a body stays in the body text (the recursion strips it itself)
  ok('substitutionBodies keeps a heredoc inside a body',
    bodies('echo "$(cat <<E\nfoo\nE\n; cat .env)"') === JSON.stringify(['cat <<E\nfoo\nE\n; cat .env']));
  ok('substitutionBodies skips a $(..) inside a heredoc inside a body',
    bodies('echo $(cat <<E\n$(cat .env)\nE\n)') === JSON.stringify(['cat <<E\n$(cat .env)\nE\n']));
  // W3: a substitution inside arithmetic runs
  ok('substitutionBodies finds $(..) inside $((..))', bodies('echo "$(( $(cat .env) ))"') === JSON.stringify(['cat .env']));
  ok('substitutionBodies finds $(..) inside $[..]', bodies('echo "$[ $(cat .env) ]"') === JSON.stringify(['cat .env']));
  ok('substitutionBodies keeps arithmetic parens balanced around a sub',
    bodies('echo "$(( ($(a)) + 1 ))" "$(b)"') === JSON.stringify(['a', 'b']));
  ok('substitutionBodies still skips plain nested arithmetic', bodies('echo $((a+(b)))') === '[]');
  // #216: backtick substitutions
  const cat = JSON.stringify(['cat .env']);
  ok('substitutionBodies finds an unquoted backtick body', bodies('echo `cat .env`') === cat);
  ok('substitutionBodies finds a double-quoted backtick body', bodies('echo "`cat .env`"') === cat);
  ok('substitutionBodies finds a backtick body in an assignment', bodies('x="`cat .env`"') === cat);
  ok('substitutionBodies finds a backtick body inside ${..}', bodies('echo "${x:-`cat .env`}"') === cat);
  ok('substitutionBodies skips a single-quoted backtick', bodies("echo '`cat .env`'") === '[]');
  ok('substitutionBodies skips a backtick inside $\'..\'', bodies("echo $'`cat .env`'") === '[]');
  ok('substitutionBodies skips a backtick in a comment', bodies('echo hi # `cat .env`') === '[]');
  ok('substitutionBodies skips an escaped backtick', bodies('echo "\\`cat .env\\`"') === '[]');
  ok('substitutionBodies reports a bq inside $(..) only as part of the outer body',
    bodies('echo "$(echo `cat .env`)"') === JSON.stringify(['echo `cat .env`']));
  ok('substitutionBodies reports a $(..) inside a bq only as part of the bq body',
    bodies('echo `echo $(cat .env)`') === JSON.stringify(['echo $(cat .env)']));
  ok('substitutionBodies returns the remainder of an unterminated backtick', bodies('echo "`cat .env') === cat);
  ok('substitutionBodies unescapes a nested backtick in a bq body',
    bodies('echo `echo \\`cat .env\\``') === JSON.stringify(['echo `cat .env`']));
  // review: the span is opaque (a quote inside it does not desync the lexer)
  ok('substitutionBodies: a quote inside a bq body does not hide its close',
    bodies('echo "`echo \'"\'`"; cat .env') === JSON.stringify(["echo '\"'"]));
  ok('substitutionBodies: a $(..) after a quote-bearing bq is still found',
    bodies('echo "`echo \'x`"; echo "$(cat .env)"') === JSON.stringify(["echo 'x", 'cat .env']));
  ok('splitStatements does not cut at a ; inside a backtick span',
    JSON.stringify(splitStatements('echo `a; b` ; c')) === JSON.stringify(['echo `a; b`', 'c']));
  ok('splitStatements does not cut at a newline inside a backtick span',
    JSON.stringify(splitStatements('echo `a\nb` ; c')) === JSON.stringify(['echo `a\nb`', 'c']));
  // review: \" is unescaped in a bq body only inside double quotes
  ok('substitutionBodies unescapes \\" in a bq body inside double quotes',
    bodies('echo "`cat \\".env\\"`"') === JSON.stringify(['cat ".env"']));
  ok('substitutionBodies keeps \\" in an unquoted bq body',
    bodies('echo `cat \\".env\\"`') === JSON.stringify(['cat \\".env\\"']));
  ok('substitutionBodies: a dq below a $(..) does not count as double-quoted',
    bodies('echo "$(echo `cat \\".env\\"`)"') === JSON.stringify(['echo `cat \\".env\\"`']));
  // review: multi-line span and double-nested escaped backtick
  ok('substitutionBodies finds a backtick span across lines', bodies('echo `true\ncat .env\n`') === JSON.stringify(['true\ncat .env\n']));
  ok('substitutionBodies keeps a double-nested escaped backtick for the recursion',
    bodies('echo `echo \\`echo \\\\\\`cat .env\\\\\\`\\``') === JSON.stringify(['echo `echo \\`cat .env\\``']));
}

// --- heredocSubstitutionBodies: substitutions in an unquoted heredoc body (#218) ---
{
  const hb = (b) => JSON.stringify(heredocSubstitutionBodies(b));
  const cat = JSON.stringify(['cat .env']);
  ok('heredocSubstitutionBodies finds a $(..)', hb('$(cat .env)') === cat);
  ok('heredocSubstitutionBodies finds a $(..) after an apostrophe (quotes are literal)', hb("it's $(cat .env)") === cat);
  ok('heredocSubstitutionBodies finds a $(..) after a double quote', hb('say "hi $(cat .env)') === cat);
  ok('heredocSubstitutionBodies finds a backtick body', hb('`cat .env`') === cat);
  ok('heredocSubstitutionBodies skips an escaped $(..)', hb('\\$(cat .env)') === '[]');
  ok('heredocSubstitutionBodies skips an escaped backtick', hb('\\`cat .env\\`') === '[]');
  ok('heredocSubstitutionBodies finds substitutions on several lines', hb('a $(one)\nb\n`two`') === JSON.stringify(['one', 'two']));
  ok('heredocSubstitutionBodies returns only the outer of a nest', hb('$(a $(b))') === JSON.stringify(['a $(b)']));
  ok('heredocSubstitutionBodies finds a $(..) inside ${..}', hb('${x:-$(cat .env)}') === cat);
  ok('heredocSubstitutionBodies joins a backslash-newline before lexing', hb('$(cat .e\\\nnv)') === cat);
  ok('heredocSubstitutionBodies joins a backslash-newline inside the opener', hb('$\\\n(cat .env)') === cat);
  ok('heredocSubstitutionBodies keeps a newline after an escaped backslash', hb('a\\\\\n$(cat .env)') === cat);
  ok('heredocSubstitutionBodies does not join an escaped backslash with its newline', hb('$(a \\\\\nb)') === JSON.stringify(['a \\\\\nb']));
  ok('heredocSubstitutionBodies keeps a heredoc nested in a substitution with its own body',
    hb('$(cat <<B\n)\nB\ncat .env)') === JSON.stringify(['cat <<B\n)\nB\ncat .env']));
  ok('heredocSubstitutionBodies finds a tab-indented $(..)', hb('\t$(cat .env)') === cat);
  ok('heredocSubstitutionBodies is empty for plain text', hb('cat .env') === '[]');
  ok('heredocSubstitutionBodies treats <(..) as literal text', hb('diff <(cat .env)') === '[]');
  ok('heredocSubstitutionBodies treats a # as literal text', hb('# $(cat .env)') === cat);
}

console.log(`✓ shell-scan: ${passed} assertions passed`);
