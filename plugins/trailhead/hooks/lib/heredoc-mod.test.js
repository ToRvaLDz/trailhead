// Mod side of #369: the mod strips heredoc bodies before it tests a Bash call for a tracker write,
// with its own import-free leaf (a mod file imports nothing from hooks/lib). This keeps the leaf's
// output equal to shell-scan's stripHeredocBodies over the commands that matter to the write check.
// The mod file is TypeScript: loaded through Node's type stripping (Node >= 22.18);
// skipped on an older Node.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripHeredocBodies } = require('./shell-scan.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

const leaf = path.join(__dirname, '..', 'mod', 'heredoc.ts');
assert.ok(fs.existsSync(leaf), 'mod/heredoc.ts is missing');
let mod = null;
try { mod = require(leaf); } catch { /* no type stripping */ }

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
];

if (mod) {
  t('the mod leaf strips like shell-scan over the write-check commands', () => {
    for (const cmd of COMMANDS) {
      assert.strictEqual(mod.stripHeredocBodies(cmd), stripHeredocBodies(cmd), JSON.stringify(cmd));
    }
  });
}

console.log(`${passed} passed${mod ? '' : ' (type stripping unavailable: leaf checks skipped)'}`);
