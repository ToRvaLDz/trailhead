#!/usr/bin/env node
// Tests for trailhead-labels-guard.js. Run: node trailhead-labels-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// TRAILHEAD_GUARD_HOOK re-runs this suite through the merged trailhead-bash-guards.js.
const HOOK = process.env.TRAILHEAD_GUARD_HOOK || path.join(__dirname, 'trailhead-labels-guard.js');
const { evaluate, parseCreate, inTrailheadRepo } = require('./trailhead-labels-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Scratch dirs: a trailhead repo (.git + .trailhead/), a plain repo (.git only), a plain dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-guard-'));
const mk = (rel, ...sub) => {
  const d = path.join(tmp, rel);
  fs.mkdirSync(d, { recursive: true });
  for (const s of sub) fs.mkdirSync(path.join(d, s), { recursive: true });
  return d;
};
const TH = mk('th', '.git', '.trailhead', 'src/deep');
const THDEEP = path.join(TH, 'src', 'deep');
const PLAIN_REPO = mk('plain', '.git');
const NOREPO = mk('norepo');
// A worktree-style repo: `.git` is a file, not a dir.
const WT = mk('wt', '.trailhead');
fs.writeFileSync(path.join(WT, '.git'), 'gitdir: /elsewhere\n');

// Run the hook end-to-end: tool_input JSON (+ cwd) on stdin, capture {code, out}.
function runHook(command, cwd) {
  const input = JSON.stringify({ tool_input: { command }, ...(cwd ? { cwd } : {}) });
  const r = spawnSync('node', [HOOK], { input, cwd: NOREPO });
  return { code: r.status, out: r.stdout.toString() };
}
const blocked = (cmd, cwd) => { const v = evaluate(cmd, { cwd, env: {} }); return !!v && v.kind === 'block'; };
const reasonOf = (cmd, cwd) => { const v = evaluate(cmd, { cwd, env: {} }); return v ? v.payload.reason : ''; };
const codeOf = (cmd, cwd) => { const v = evaluate(cmd, { cwd, env: {} }); return v ? v.payload.code : null; };

const create = (labels, extra = '') =>
  `gh issue create --title x --body y ${labels.map((l) => `--label ${l}`).join(' ')} ${extra}`.trim();
const FULL_WB = ['trailhead:ticket', 'trailhead:bug', 'trailhead:whiteboard'];
const FULL_MAP = ['trailhead:ticket', 'trailhead:build', 'trailhead:map-12'];

// --- the repro commands (#308) ---
{
  const r1 = 'gh issue create --label trailhead:bug --label trailhead:whiteboard --title x --body-file /dev/null';
  const r2 = 'gh issue create --label "trailhead:bug,trailhead:whiteboard" --title x --body y';
  const r3 = 'gh issue create --title x --body y';
  for (const c of [r1, r2]) {
    ok(`blocks partial set: ${c.slice(0, 50)}`, blocked(c, NOREPO));
    ok('names the missing ticket label', reasonOf(c, NOREPO).includes('missing `trailhead:ticket`'));
    ok('tells to retry in the same create call', /SAME `gh issue create`/.test(reasonOf(c, NOREPO)) && /--add-label/.test(reasonOf(c, NOREPO)));
    const h = runHook(c, NOREPO);
    ok('hook exits 2 with a block payload', h.code === 2 && JSON.parse(h.out).decision === 'block');
  }
  ok('no-label create is blocked in a trailhead repo', blocked(r3, TH));
  ok('no-label block mentions the opt-out', reasonOf(r3, TH).includes('TRAILHEAD_PLAIN_ISSUE=1'));
  const h = runHook(r3, TH);
  ok('no-label hook exits 2 inside a trailhead repo', h.code === 2 && JSON.parse(h.out).code === 'TRAILHEAD_ISSUE_WITHOUT_LABELS');
  ok('no-label hook exits 0 outside', runHook(r3, NOREPO).code === 0);
}

// --- a complete ticket is allowed ---
ok('whiteboard ticket passes', !blocked(create(FULL_WB), TH));
ok('map ticket passes', !blocked(create(FULL_MAP), TH));
ok('comma-separated full set passes', !blocked('gh issue create --title x --body y --label "trailhead:ticket,trailhead:task,trailhead:map-3"', TH));
ok('-l shorthand passes', !blocked('gh issue create -t x -b y -l trailhead:ticket -l trailhead:research -l trailhead:whiteboard', TH));
ok('--label=value passes', !blocked('gh issue create --title x --body y --label=trailhead:ticket --label=trailhead:decision --label=trailhead:whiteboard', TH));
ok('glued -lvalue passes', !blocked('gh issue create -t x -b y -ltrailhead:ticket -ltrailhead:task -ltrailhead:map-1', TH));
ok('quoted values pass', !blocked('gh issue create --title x --body y --label "trailhead:ticket" --label \'trailhead:prototype\' --label "trailhead:whiteboard"', TH));
ok('state labels are allowed extras', !blocked(create([...FULL_WB, 'trailhead:blocked', 'trailhead:needs-you', 'bug']), TH));
ok('non-trailhead labels beside a full set pass', !blocked(create([...FULL_MAP, 'enhancement']), NOREPO));
ok('every type passes', ['decision', 'research', 'prototype', 'build', 'bug', 'task']
  .every((t) => !blocked(create(['trailhead:ticket', `trailhead:${t}`, 'trailhead:whiteboard']), TH)));
ok('seed shape passes', !blocked(create(['trailhead:ticket', 'trailhead:task', 'trailhead:map-4', 'trailhead:seed', 'trailhead:blocked']), TH));
ok('a seed without type is blocked', blocked(create(['trailhead:ticket', 'trailhead:map-4', 'trailhead:seed', 'trailhead:blocked']), TH));

// --- the shape rules, with the names in the reason ---
{
  const noTicket = create(['trailhead:bug', 'trailhead:map-2']);
  ok('missing ticket blocks', blocked(noTicket, NOREPO) && reasonOf(noTicket, NOREPO).includes('missing `trailhead:ticket`'));
  const noType = create(['trailhead:ticket', 'trailhead:whiteboard']);
  ok('missing type blocks', blocked(noType, NOREPO) && /missing a type label/.test(reasonOf(noType, NOREPO)));
  ok('missing type names the choices', reasonOf(noType, NOREPO).includes('trailhead:decision'));
  const noDest = create(['trailhead:ticket', 'trailhead:bug']);
  ok('missing destination blocks', blocked(noDest, NOREPO) && /missing a destination/.test(reasonOf(noDest, NOREPO)));
  const both = create(['trailhead:ticket', 'trailhead:bug', 'trailhead:map-2', 'trailhead:whiteboard']);
  ok('both destinations block', blocked(both, NOREPO) && /two destinations \(trailhead:map-2 and trailhead:whiteboard\)/.test(reasonOf(both, NOREPO)));
  const twoMaps = create(['trailhead:ticket', 'trailhead:bug', 'trailhead:map-2', 'trailhead:map-3']);
  ok('two maps block', blocked(twoMaps, NOREPO) && /two map destinations \(trailhead:map-2, trailhead:map-3\)/.test(reasonOf(twoMaps, NOREPO)));
  const twoTypes = create(['trailhead:ticket', 'trailhead:bug', 'trailhead:task', 'trailhead:whiteboard']);
  ok('two types block', blocked(twoTypes, NOREPO) && /conflicting type labels \(trailhead:bug, trailhead:task\)/.test(reasonOf(twoTypes, NOREPO)));
  const multi = create(['trailhead:whiteboard']);
  ok('several gaps are all named', ['trailhead:ticket', 'type label'].every((n) => reasonOf(multi, NOREPO).includes(n)));
  ok('a state label alone does not satisfy the shape', blocked(create(['trailhead:blocked']), NOREPO));
  ok('trailhead:map alone is not a destination for a ticket',
    !blocked(create(['trailhead:map']), NOREPO)); // it IS the map issue, exempt
  ok('a bare map-x (not digits) is no destination', blocked(create(['trailhead:ticket', 'trailhead:bug', 'trailhead:map-x']), NOREPO));
  ok('labels are matched case-insensitively', !blocked(create(['Trailhead:Ticket', 'TRAILHEAD:BUG', 'trailhead:WhiteBoard']), NOREPO));
}

// --- non-ticket trailhead issues are exempt ---
for (const l of ['trailhead:map', 'trailhead:dashboard', 'trailhead:codebase', 'trailhead:conventions', 'trailhead:fog', 'trailhead:unverified']) {
  ok(`${l} create passes`, !blocked(create([l]), TH));
}
ok('map issue with extra labels passes', !blocked(create(['trailhead:map', 'trailhead:paused']), TH));

// --- no-label ground: only inside a trailhead repo ---
{
  const bare = 'gh issue create --title x --body y';
  ok('blocked at the trailhead repo root', blocked(bare, TH));
  ok('blocked from a subdirectory (walks up to .git)', blocked(bare, THDEEP));
  ok('blocked in a worktree whose .git is a file', blocked(bare, WT));
  ok('allowed in a repo without .trailhead/', !blocked(bare, PLAIN_REPO));
  ok('allowed outside any repo', !blocked(bare, NOREPO));
  ok('allowed with an unlabelled non-trailhead label', !blocked(bare, NOREPO) && blocked(`${bare} --label bug`, TH));
  ok('TRAILHEAD_PLAIN_ISSUE=1 opts out', !blocked(`TRAILHEAD_PLAIN_ISSUE=1 ${bare}`, TH));
  ok('opt-out works on a compound command', !blocked(`cd x; TRAILHEAD_PLAIN_ISSUE=1 ${bare}`, TH));
  ok('TRAILHEAD_PLAIN_ISSUE=0 does not opt out', blocked(`TRAILHEAD_PLAIN_ISSUE=0 ${bare}`, TH));
  ok('opt-out never excuses a partial trailhead set', blocked(`TRAILHEAD_PLAIN_ISSUE=1 ${create(['trailhead:bug'])}`, TH));
  ok('-R other/repo is not blocked on the no-label ground', !blocked(`${bare} -R other/repo`, TH));
  ok('--repo=other/repo is not blocked on the no-label ground', !blocked(`${bare} --repo=other/repo`, TH));
  ok('global -R before the subcommand is not blocked', !blocked('gh -R other/repo issue create --title x --body y', TH));
  ok('GH_REPO=other/repo is not blocked on the no-label ground', !blocked(`GH_REPO=other/repo ${bare}`, TH));
  ok('-R other/repo is still checked on the partial-label ground', blocked(`${create(['trailhead:bug'])} -R other/repo`, TH));
  ok('--web with no labels is treated like any create', blocked('gh issue create --web', TH));
  ok('an unreadable cwd fails open', !blocked(bare, path.join(tmp, 'does', 'not', 'exist')));
  ok('inTrailheadRepo: .trailhead as a plain file is not a trailhead repo', (() => {
    const d = mk('filedir', '.git');
    fs.writeFileSync(path.join(d, '.trailhead'), 'x');
    return inTrailheadRepo(d) === false;
  })());
}

// --- unresolvable labels fail open ---
ok('$VAR label does not block', !blocked('gh issue create --title x --body y --label "$LABEL"', TH));
ok('$VAR beside a partial set does not block', !blocked('gh issue create --title x --body y --label trailhead:bug --label $L', TH));
ok('backtick label does not block', !blocked('gh issue create --title x --body y --label `cat l`', TH));
ok('$(...) label does not block', !blocked('gh issue create --title x --body y --label "$(echo trailhead:bug)"', TH));
ok('${VAR}-embedded label does not block', !blocked('gh issue create --title x --body y --label "trailhead:${KIND}"', TH));

// --- compound commands, wrappers, quoting ---
{
  const bad = 'gh issue create --title x --body y --label trailhead:bug';
  ok('after cd &&', blocked(`cd x && ${bad}`, NOREPO));
  ok('after ;', blocked(`echo hi; ${bad}`, NOREPO));
  ok('after &&', blocked(`true && ${bad}`, NOREPO));
  ok('after ||', blocked(`false || ${bad}`, NOREPO));
  ok('in a subshell', blocked(`(${bad})`, NOREPO));
  ok('behind a leading assignment', blocked(`FOO=1 ${bad}`, NOREPO));
  ok('behind a global flag', blocked('gh --hostname h issue create --title x --body y --label trailhead:bug', NOREPO));
  ok('behind -R', blocked('gh -R o/r issue create --title x --body y --label trailhead:bug', NOREPO));
  ok('quoted gh word', blocked('"gh" issue create --title x --body y --label trailhead:bug', NOREPO));
  ok('the second of two creates is checked', blocked(`${create(FULL_WB)} && ${bad}`, NOREPO));
  ok('two good creates pass', !blocked(`${create(FULL_WB)} && ${create(FULL_MAP)}`, TH));
  ok('after a cd the cwd is unknown: no-label ground does not block', !blocked('cd /elsewhere && gh issue create --title x --body y', TH));
  ok('a label-looking word in the title is not a label', blocked('gh issue create --title "--label trailhead:ticket" --body y --label trailhead:bug', NOREPO));
  ok('a label-looking word in the body is not a label', !blocked('gh issue create --title x --body "-l trailhead:bug" --label trailhead:ticket --label trailhead:bug --label trailhead:whiteboard', NOREPO));
  ok('a quoted gh text in an echo is not a create', !blocked('echo "gh issue create --label trailhead:bug"', TH));
  ok('a heredoc body mentioning a create is not a create', !blocked('cat <<EOF\ngh issue create --label trailhead:bug\nEOF', TH));
  ok('the create is blocked through a pipeline', blocked(`echo y | ${bad}`, NOREPO));
}

// --- everything that is not `gh issue create` is untouched ---
for (const c of [
  'gh issue edit 5 --add-label trailhead:bug',
  'gh issue list --label trailhead:bug',
  'gh issue view 5 --json labels',
  'gh issue comment 5 --body hi',
  'gh pr create --title x --body y',
  'gh pr create --title x --body y --label trailhead:bug',
  'git status',
  'gh label create trailhead:bug',
  'gh api repos/o/r/issues -f title=x',
  '',
]) ok(`untouched: ${c || '(empty)'}`, !blocked(c, TH));

// --- help and shell comments (review of #308) ---
ok('--help is not a create', !blocked('gh issue create --help', TH));
ok('-h is not a create', !blocked('gh issue create -h', TH));
ok('a trailing comment cannot supply the labels',
  blocked('gh issue create -t x -b y # --label trailhead:ticket,trailhead:bug,trailhead:whiteboard', TH));
ok('a comment after a full set changes nothing', !blocked(`${create(FULL_WB)} # note`, TH));
ok('a quoted # is still a value', !blocked('gh issue create -t "#1 x" -b y --label "trailhead:ticket,trailhead:bug,trailhead:whiteboard"', TH));

// --- parseCreate ---
{
  const p = parseCreate('gh issue create -l a,b --label=c -ld --title t');
  ok('parseCreate reads every label form', JSON.stringify(p.labels) === JSON.stringify(['a', 'b', 'c', 'd']));
  ok('parseCreate flags an unresolved value', parseCreate('gh issue create --label $X').unresolved === true);
  ok('parseCreate sees -R', parseCreate('gh issue create -R o/r').repoFlag === true);
}

// --- crash-safety ---
ok('non-string input does not throw', evaluate(undefined, {}) === null && evaluate(null) === null);
{
  const bad = spawnSync('node', [HOOK], { input: 'not json {{' });
  ok('unparseable hook input exits 0', bad.status === 0);
  const nul = spawnSync('node', [HOOK], { input: 'null' });
  ok('null hook input exits 0', nul.status === 0);
  const clean = runHook('git status', TH);
  ok('a clean command exits 0 with empty stdout', clean.code === 0 && clean.out === '');
  const good = runHook(create(FULL_WB), TH);
  ok('a full whiteboard create exits 0 end to end', good.code === 0 && good.out === '');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`labels-guard: ${passed} assertions passed`);
