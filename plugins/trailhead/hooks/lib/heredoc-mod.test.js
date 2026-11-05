// Mod side of #369: the mod strips heredoc bodies before it tests a Bash call for a tracker write,
// with its own import-free leaf (a mod file imports nothing from hooks/lib). This keeps the leaf's
// output equal to shell-scan's stripHeredocBodies over the commands that matter to the write check.
// The mod file is TypeScript: loaded through Node's type stripping (Node >= 22.18);
// skipped (with an explicit SKIP line) on a Node with no type stripping; any other load error fails.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripHeredocBodies } = require('./shell-scan.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

const leaf = path.join(__dirname, '..', 'mod', 'heredoc.ts');
assert.ok(fs.existsSync(leaf), 'mod/heredoc.ts is missing');
let mod = null;
try {
  mod = require(leaf);
} catch (err) {
  // Only a Node with no type stripping may skip; a syntax error in the leaf must fail the test.
  const noStripping = err.code === 'ERR_UNKNOWN_FILE_EXTENSION' || !process.features.typescript;
  if (!noStripping) throw err;
  console.log(`SKIP - mod/heredoc.ts not loadable without type stripping (${err.code || err.name})`);
}

const COMMANDS = [
  'cat >f <<EOF\ngh issue close 5\nEOF',
  "cat >f <<'EOF'\ngh issue close 5\nEOF",
  'cat >f <<"EOF"\ngh issue close 5\nEOF',
  'cat >f <<-EOF\n\tgh issue close 5\n\tEOF',
  'cat <<A >a; cat <<B >b\ngh issue close 1\nA\ngh issue edit 2\nB',
  'cat <<A >a; cat <<B >b\nx\nA\ny\nB\ngh issue close 3',
  'gh issue create --body-file - <<EOF\nbody\nEOF',
  'gh issue comment 5 -F - <<EOF\ngh issue close 9\nEOF',
  "cat <<'EOF' >x\nb\nEOF\ngh issue close 5",
  "cat <<'EOF' >x\nEOF2\ngh issue close 5\n EOF\nEOF",
  "cat <<'EOF' >x\ngh issue close 5",
  'cat <<-EOF >x\nb\n  EOF\ngh issue close 5\nEOF',
  "cat <<< 'x'\ngh issue close 5",
  'echo $((1<<2))\ngh issue close 5',
  'echo $((1<<2)); gh issue view 5',
  "cat <<'EOF' >x\nnode trailhead-issue-body.js append\nEOF",
  'echo "a <<EOF"\ngh issue close 5',
  'gh issue close 5',
  // W1: a `<<` in a comment opens nothing
  '# build body with <<EOF\ngh issue close 5',
  'git commit -m "x" # see <<EOF\ngh issue close 5',
  'echo a;# c <<EOF\ngh issue close 5',
  'echo a&&(# c <<EOF\ngh issue close 5',
  // a `#` inside a word is no comment
  'cat a#b <<EOF\ngh issue close 5\nEOF',
  'cat a#b <<EOF\ngh issue close 5',
  // W2: an opener inside a multi-line quoted string opens nothing
  'echo "a\ncat <<EOF\nb"\ngh issue close 5\nEOF',
  "echo 'a\ncat <<EOF\nb'\ngh issue close 5",
  'echo "a\n# x <<EOF\nb" <<EOF\ngh issue close 5\nEOF\ngh issue edit 2',
  'echo "unbalanced\ncat <<EOF\ngh issue close 5\nEOF',
  // a `<<` inside a parameter expansion opens nothing
  'echo ${x:-<<EOF}\ngh issue close 5\nEOF',
  'echo ${x:-<<EOF\ngh issue close 5',
  // a body is not scanned for quotes: its apostrophe leaks nowhere
  "cat <<EOF\nit's\nEOF\ncat <<B\ngh issue close 5\nB",
  "cat <<EOF\nit's\nEOF\ngh issue close 5",
];

// Known difference (I1): shell-scan sees an opener inside `$(..)` that the leaf does not, so the
// leaf keeps those lines (an extra read at worst). Asserted, not emulated.
const KNOWN_DIFFS = [
  'echo "$(cat <<EOF\nhello\nEOF\n)"',
];

if (mod) {
  t('the mod leaf strips like shell-scan over the write-check commands', () => {
    for (const cmd of COMMANDS) {
      assert.strictEqual(mod.stripHeredocBodies(cmd), stripHeredocBodies(cmd), JSON.stringify(cmd));
    }
  });
  t('the known $(..) difference keep the lines (safe direction)', () => {
    for (const cmd of KNOWN_DIFFS) {
      assert.strictEqual(mod.stripHeredocBodies(cmd), cmd, JSON.stringify(cmd));
    }
  });
}

console.log(`${passed} passed${mod ? '' : ' (type stripping unavailable: leaf checks skipped)'}`);
