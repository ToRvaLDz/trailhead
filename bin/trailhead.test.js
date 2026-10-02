#!/usr/bin/env node
// Integration tests for trailhead.js (the installer). Run: node trailhead.test.js
// No framework: plain asserts, mirrors the style of host-descriptor.test.js.
// Drives the real CLI via child_process against fresh temp dirs, passing an
// explicit --codex/--claude flag (or a controlled $PATH for the auto-detect
// cases) plus --dir= so no TTY prompt can fire.
//
// Since #25, BOTH codex and claude installs produce <dir>/skills/trailhead/
// SKILL.md, so that path alone no longer tells them apart. Distinguish by:
// codex has NO commands/ dir and NO settings.json (still Claude-only), but
// (since #29) DOES have hooks.json + skills/trailhead/hooks/ + config.toml,
// and its SKILL.md STARTS WITH <codex_skill_adapter> plus a
// skills/trailhead/agents/openai.yaml; claude HAS commands/trailhead/,
// settings.json, hooks/, and its SKILL.md does NOT start with the adapter
// header.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const repoRoot = path.resolve(__dirname, '..');
const installerPath = path.join(repoRoot, 'bin', 'trailhead.js');
const tmpDirs = [];

function mktmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  tmpDirs.push(d);
  return d;
}

// process.execPath (not the bare 'node') so a test can hand a stripped-down
// $PATH to exercise the auto-detect branch without losing the node binary.
function runInstaller(extraArgs, opts = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const cwd = opts.cwd || repoRoot;
  return execFileSync(process.execPath, [installerPath, ...extraArgs], { cwd, stdio: 'pipe', env });
}

// A dir holding an executable stub for each named host CLI, so detectInstalledHosts
// finds them when this dir is the whole $PATH.
function fakeBinDir(names) {
  const dir = mktmp();
  for (const name of names) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

// #187: the pinned-model review's documented lib path (see load-first.md) is
// relative to a skills/_shared/ dir; assert it actually resolves on every
// install layout, survives realpathSync, and its check/ack CLI round-trips.
const MODEL_DEFAULTS_LIB_CANDIDATES = [
  '../../hooks/lib/model-defaults-review.js',
  '../trailhead/hooks/lib/model-defaults-review.js',
];
function assertModelDefaultsLibLayout(label, sharedDir) {
  const resolved = MODEL_DEFAULTS_LIB_CANDIDATES
    .map((c) => path.join(sharedDir, c))
    .find((p) => fs.existsSync(p));
  ok(`${label}: documented model-defaults-review.js lib path resolves`, !!resolved);
  if (!resolved) return;
  ok(`${label}: resolved lib path still resolves after realpathSync`,
    fs.existsSync(fs.realpathSync(resolved)));

  const tmpProject = mktmp();
  fs.mkdirSync(path.join(tmpProject, '.trailhead'), { recursive: true });
  fs.writeFileSync(path.join(tmpProject, '.trailhead', 'config.json'),
    JSON.stringify({ models: { plan: 'claude-opus-4-8' } }));

  const noticeOut = String(execFileSync(process.execPath, [resolved, 'check', tmpProject], { encoding: 'utf8' }));
  ok(`${label}: CLI check prints a notice`, noticeOut.trim().length > 0 && noticeOut.includes('models.plan'));

  execFileSync(process.execPath, [resolved, 'ack', tmpProject], { encoding: 'utf8' });
  const afterAckOut = String(execFileSync(process.execPath, [resolved, 'check', tmpProject], { encoding: 'utf8' }));
  ok(`${label}: CLI check prints nothing after CLI ack`, afterAckOut === '');
}

// Source/plugin layout itself (not an installed copy), so drift is caught
// even before an install is exercised.
assertModelDefaultsLibLayout('source', path.join(repoRoot, 'plugins', 'trailhead', 'skills', '_shared'));

// --- codex install -----------------------------------------------------------
const codexDir = mktmp();
const codexInstallOut = String(runInstaller([`--codex`, `--dir=${codexDir}`]));

const skillMainPath = path.join(codexDir, 'skills', 'trailhead', 'SKILL.md');
ok('codex: SKILL.md exists', fs.existsSync(skillMainPath));
const skillMainContent = fs.readFileSync(skillMainPath, 'utf8');
// #40: the YAML frontmatter must stay at the very top (Codex only registers a
// skill when `name:`/`description:` are the first bytes); the adapter header is
// injected AFTER the frontmatter, not above it.
ok('codex: SKILL.md starts with the YAML frontmatter', skillMainContent.startsWith('---\n'));
ok('codex: SKILL.md frontmatter precedes the adapter header',
  skillMainContent.indexOf('name: trailhead') < skillMainContent.indexOf('<codex_skill_adapter>'));
ok('codex: SKILL.md still carries the adapter header', skillMainContent.includes('<codex_skill_adapter>'));
// The adapter header itself (mandated EXACT text) intentionally contrasts the
// $trailhead form with the old slash-namespace form ("Never /trailhead:<verb>"),
// so it legitimately contains that substring once. Scope the check to the
// converted engine body, after the header, which is where the command-surface
// rewrite actually applies.
const engineBody = skillMainContent.slice(skillMainContent.indexOf('</codex_skill_adapter>'));
ok('codex: SKILL.md engine body has no /trailhead: substring', !engineBody.includes('/trailhead:'));

ok('codex: _shared/techniques/grilling.md exists', fs.existsSync(path.join(codexDir, 'skills', '_shared', 'techniques', 'grilling.md')));

const agentsYamlPath = path.join(codexDir, 'skills', 'trailhead', 'agents', 'openai.yaml');
ok('codex: agents/openai.yaml exists', fs.existsSync(agentsYamlPath));
ok('codex: agents/openai.yaml disallows implicit invocation', fs.readFileSync(agentsYamlPath, 'utf8').includes('allow_implicit_invocation: false'));

const codexTemplate = path.join(codexDir, 'skills', 'trailhead', 'templates', 'trailhead-commit-msg');
ok('codex: commit-msg template projected', fs.existsSync(codexTemplate));
ok('codex: commit-msg template is verbatim (not converted)',
  fs.readFileSync(codexTemplate, 'utf8') === fs.readFileSync(path.join(repoRoot, 'plugins', 'trailhead', 'templates', 'trailhead-commit-msg'), 'utf8'));

// #185: the commit-msg hook sync script ships wholesale with templates/ too.
const codexCommitMsgSync = path.join(codexDir, 'skills', 'trailhead', 'templates', 'trailhead-commit-msg-sync.js');
ok('codex: commit-msg-sync script projected', fs.existsSync(codexCommitMsgSync));
ok('codex: commit-msg-sync script is byte-identical to source',
  fs.readFileSync(codexCommitMsgSync, 'utf8') === fs.readFileSync(path.join(repoRoot, 'plugins', 'trailhead', 'templates', 'trailhead-commit-msg-sync.js'), 'utf8'));

ok('codex: no commands dir', !fs.existsSync(path.join(codexDir, 'commands')));
ok('codex: no settings.json file', !fs.existsSync(path.join(codexDir, 'settings.json')));
// #46: per-verb discoverability now projects one Codex SKILL per verb
// (skills/trailhead-<verb>/), invocable as $trailhead-<verb>. The old
// ~/.codex/prompts/ shims never surfaced as slash commands on Codex.
// #46 per-verb discoverability skills. `work` collides with the work CLUSTER
// dir, so its discoverability is the cluster itself; use a non-colliding verb.
ok('codex: per-verb skills/trailhead-bug/SKILL.md exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead-bug', 'SKILL.md')));
ok('codex: trailhead-bug SKILL.md frontmatter is at byte 0', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-bug', 'SKILL.md'), 'utf8').startsWith('---\nname: trailhead-bug\n'));
ok('codex: trailhead-bug skill delegates to $trailhead bug', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-bug', 'SKILL.md'), 'utf8').includes('$trailhead bug'));
ok('codex: per-verb skill is explicit-only', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-bug', 'agents', 'openai.yaml'), 'utf8').includes('allow_implicit_invocation: false'));
// auto is a plain verb skill too: no trailhead-auto CLUSTER dir exists, so it
// projects a thin per-verb skill exactly like bug/quick/pause.
ok('codex: per-verb skills/trailhead-auto/SKILL.md exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead-auto', 'SKILL.md')));
ok('codex: trailhead-auto SKILL.md frontmatter is at byte 0', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-auto', 'SKILL.md'), 'utf8').startsWith('---\nname: trailhead-auto\n'));
ok('codex: trailhead-auto skill delegates to $trailhead auto', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-auto', 'SKILL.md'), 'utf8').includes('$trailhead auto'));
// The trailhead-work dir is the WORK CLUSTER skill (not a thin verb delegator).
ok('codex: trailhead-work is the cluster skill (frontmatter name at byte 0)', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').startsWith('---\nname: trailhead-work\n'));
ok('codex: trailhead-work cluster carries the adapter header', fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').includes('<codex_skill_adapter>'));
ok('codex: NO thin trailhead-work verb-delegator (cluster occupies the name)', !fs.readFileSync(path.join(codexDir, 'skills', 'trailhead-work', 'SKILL.md'), 'utf8').includes('This is a thin discoverability entry'));
ok('codex: no ~/.codex/prompts shims left (old mechanism dropped)', !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead.md')) && !fs.existsSync(path.join(codexDir, 'prompts', 'trailhead-work.md')));

// The split ships all sibling engine skills so the ../_shared/ relative refs resolve.
ok('codex: _shared/ projected', fs.existsSync(path.join(codexDir, 'skills', '_shared', 'substrate.md')));
for (const cl of ['trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`codex: cluster ${cl} SKILL.md projected`, fs.existsSync(path.join(codexDir, 'skills', cl, 'SKILL.md')));
  ok(`codex: cluster ${cl} carries the adapter header`, fs.readFileSync(path.join(codexDir, 'skills', cl, 'SKILL.md'), 'utf8').includes('<codex_skill_adapter>'));
  ok(`codex: cluster ${cl} frontmatter precedes the adapter header`, (() => { const c = fs.readFileSync(path.join(codexDir, 'skills', cl, 'SKILL.md'), 'utf8'); return c.startsWith('---\n') && c.indexOf('name:') < c.indexOf('<codex_skill_adapter>'); })());
  ok(`codex: cluster ${cl} agents/openai.yaml explicit-only`, fs.readFileSync(path.join(codexDir, 'skills', cl, 'agents', 'openai.yaml'), 'utf8').includes('allow_implicit_invocation: false'));
}
// A cluster's ../_shared/ reference target actually resolves as a sibling.
ok('codex: trailhead-work/../_shared/substrate.md resolves', fs.existsSync(path.join(codexDir, 'skills', 'trailhead-work', '..', '_shared', 'substrate.md')));

// --- #139: single-sourced "Load first, in order" shared section --------------
ok('codex: _shared/load-first.md projected', fs.existsSync(path.join(codexDir, 'skills', '_shared', 'load-first.md')));
for (const cl of ['trailhead', 'trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`codex: ${cl}/../_shared/load-first.md resolves as a sibling`, fs.existsSync(path.join(codexDir, 'skills', cl, '..', '_shared', 'load-first.md')));
  ok(`codex: ${cl} SKILL.md references ../_shared/load-first.md`, fs.readFileSync(path.join(codexDir, 'skills', cl, 'SKILL.md'), 'utf8').includes('../_shared/load-first.md'));
}
// Source-level anti-drift: the shared core-list signature line lives ONLY in
// _shared/load-first.md, never duplicated back into a cluster SKILL.md.
const sourceSkillsDir = path.join(__dirname, '..', 'plugins', 'trailhead', 'skills');
const loadFirstSignature = '`../_shared/principles.md`: refer by name';
const loadFirstSourcePath = path.join(sourceSkillsDir, '_shared', 'load-first.md');
ok('source: _shared/load-first.md carries the core-list signature line', fs.readFileSync(loadFirstSourcePath, 'utf8').includes(loadFirstSignature));
for (const cl of ['trailhead', 'trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`source: ${cl}/SKILL.md does NOT duplicate the core-list signature line`, !fs.readFileSync(path.join(sourceSkillsDir, cl, 'SKILL.md'), 'utf8').includes(loadFirstSignature));
}

// --- #146: single-sourced ticket-language directive (anti-drift) -------------
// The standing ticket-language rule (write Issue prose + commit bodies in
// config.ticket.language, decoupled from the chat language) lives in ONE place,
// _shared/ticket-language.md; it is listed in the load contract's six-file core
// and REFERENCED (never restated) by the engine references. Mirrors the #139
// load-first invariant so the directive can't silently drift.
ok('codex: _shared/ticket-language.md projected', fs.existsSync(path.join(codexDir, 'skills', '_shared', 'ticket-language.md')));
for (const cl of ['trailhead', 'trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`codex: ${cl}/../_shared/ticket-language.md resolves as a sibling`, fs.existsSync(path.join(codexDir, 'skills', cl, '..', '_shared', 'ticket-language.md')));
}
// The single source states the rule's substance: the canonical config key AND
// the decoupling clause (the heart of the rule), not merely a heading.
const ticketLangSourcePath = path.join(sourceSkillsDir, '_shared', 'ticket-language.md');
const ticketLangSource = fs.readFileSync(ticketLangSourcePath, 'utf8');
const ticketLangKey = '`config.ticket.language`';
const ticketLangDecoupling = '**independent of the language the agent converses in**';
ok('source: ticket-language.md states the rule (config.ticket.language + decoupling clause)',
  ticketLangSource.includes(ticketLangKey) && ticketLangSource.includes(ticketLangDecoupling));
// The load contract lists it in the six-file core (item 2), by path reference.
const loadFirstSource = fs.readFileSync(loadFirstSourcePath, 'utf8');
ok('source: load-first.md references ../_shared/ticket-language.md', loadFirstSource.includes('../_shared/ticket-language.md'));
// The engine references point AT the single source (path reference), not restate it.
const ticketLangAutoSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-work', 'references', 'auto.md'), 'utf8');
const ticketLangCaptureSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-capture', 'references', 'capture.md'), 'utf8');
ok('source: auto.md references ticket-language.md', ticketLangAutoSource.includes('ticket-language.md'));
ok('source: capture.md references ticket-language.md', ticketLangCaptureSource.includes('ticket-language.md'));
// Source-level anti-drift: the substantive decoupling clause lives in EXACTLY
// one file across the whole skills tree, _shared/ticket-language.md. A global
// single-occurrence scan (not an enumerated per-file list) so any future doc
// that restates the verbatim directive is caught, including reachable
// shared-core references beyond the load contract and the two engine references
// (e.g. configuration-reference.md, choices.md). The legitimate paraphrases in
// configuration-reference.md/capture.md reword the rule and do not match this
// bolded verbatim clause, so they don't trip the scan.
const mdFilesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? mdFilesUnder(full) : (e.name.endsWith('.md') ? [full] : []);
});
const ticketLangClauseFiles = mdFilesUnder(sourceSkillsDir).filter((f) => fs.readFileSync(f, 'utf8').includes(ticketLangDecoupling));
ok('source: ticket-language clause appears in exactly one skills-tree file', ticketLangClauseFiles.length === 1);
ok('source: that one file is _shared/ticket-language.md', ticketLangClauseFiles.length === 1 && path.basename(ticketLangClauseFiles[0]) === 'ticket-language.md');

// --- #147: chart's close anchors the next step to /trailhead:work -----------
// Source-level invariant: charting.md renders a codified next-step block at the
// chart/adopt close, led by /clear, anchored to /trailhead:work (the map-frontier
// verb) with /trailhead:quick only as the off-map alternative, single-sourced
// once in Mode 1 step 6 with Mode 1-bis reaching it via "As Mode 1, steps 4-6".
const chartingSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-chart', 'references', 'charting.md'), 'utf8');
ok('source: charting.md close carries a codified next-step block', /Next-step block \(the close of chart/.test(chartingSource));
// Structural: the rendered blockquote must LEAD with a standalone /clear bullet
// (guards the "never demote /clear to a trailing parenthetical" regression #147 exists for).
ok('source: charting.md next-step block leads with a standalone /clear bullet', /> \*\*Prossimo passo:\*\*\n> - `\/clear`/.test(chartingSource));
// Structural: /trailhead:work is the primary bullet, carrying the number (name in prose).
ok('source: charting.md next-step block makes /trailhead:work the primary move with the number', /`\/trailhead:work <numero>` per lavorare \*\*<nome/.test(chartingSource));
// Structural: /trailhead:quick is demoted to the last "in alternativa ... fuori mappa" bullet.
ok('source: charting.md next-step block demotes /trailhead:quick to the off-map alternative bullet', /> - in alternativa `\/trailhead:quick[^\n]*fuori mappa/.test(chartingSource));
ok('source: charting.md next-step block presents several independent tickets as a set to choose from', chartingSource.includes('set to choose from'));
ok('source: charting.md next-step block frames quick as the off-map alternative', chartingSource.includes('only as the off-map alternative'));
ok('source: charting.md single-sources the block via the "As Mode 1, steps 4-6" reference', /As Mode 1, steps 4[–-]6/.test(chartingSource));
const chartSkillSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-chart', 'SKILL.md'), 'utf8');
ok('source: trailhead-chart SKILL.md config-offer points at the next-step block', chartSkillSource.includes('next-step block') && chartSkillSource.includes('/trailhead:work'));

// --- #149: capture confirmation anchors the next step to /trailhead:work -----
// Source-level invariant, mirroring #147 for chart: capture.md's confirmation-line
// rule names /trailhead:work as the anchor (full engine, keeps the map record) and
// demotes /trailhead:quick to the off-map / no-split alternative, offered alongside,
// never in its place. Localized + ordered assertions (not broad substrings): the anchor
// clause precedes the quick-demotion clause within the Confirmation line. Targets the
// capture confirmation line specifically, NOT a blanket /trailhead:quick ban
// (session-handoff.md legitimately offers /trailhead:quick <n> for the next loose ticket).
const captureSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-capture', 'references', 'capture.md'), 'utf8');
ok('source: capture.md confirmation anchors the next step to /trailhead:work', /[Aa]nchor the next step to `\/trailhead:work <n>`, always/.test(captureSource));
ok('source: capture.md offers /trailhead:quick as the lighter alternative, after the work anchor',
  /[Aa]nchor the next step to `\/trailhead:work <n>`[\s\S]{0,400}`\/trailhead:quick <n>` is the \*\*lighter alternative\*\*/.test(captureSource));
ok('source: capture.md says quick is offered alongside work, never in its place', captureSource.includes('never in its place'));
ok('source: capture.md keeps /trailhead:work the anchor even for a whiteboard capture', /whiteboard[\s\S]{0,200}the anchor stays `\/trailhead:work <n>`/.test(captureSource));

// --- #179: `quick <n>` on a map ticket is never "off the map" ----------------
// Source-level invariant: `quick <n>` on an EXISTING ticket does not leave the
// map (it keeps its trailhead:map-<n> label and sub-issue edge, and dependent-
// unblocking still runs); "off the map" describes only `quick "<text>"`, which
// opens a NEW whiteboard ticket. capture.md, session-handoff.md, and
// trailhead-work/SKILL.md must no longer carry the old "that same work done
// off the map" phrasing, nor describe `quick <n>` itself as off the map.
const sessionHandoffSource = fs.readFileSync(path.join(sourceSkillsDir, '_shared', 'session-handoff.md'), 'utf8');
const workSkillSourceFor179 = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-work', 'SKILL.md'), 'utf8');
const offMapQuickN = /`?quick <n>`?[^.\n]{0,80}off the map/i;
// The explicit "never describe ... as off the map" clause legitimately puts
// `quick <n>` near "off the map" in the same sentence, so strip it before
// running the negative proximity check below.
const neverDescribeClause = /[Nn]ever describe `quick <n>`[^\n]*?off the map\.?/;
const sessionHandoffMinusClause = sessionHandoffSource.replace(neverDescribeClause, '');
ok('source: capture.md drops the old "that same work done off the map" phrasing', !captureSource.includes('that same work done off the map'));
ok('source: session-handoff.md drops the old "that same work done off the map" phrasing', !sessionHandoffSource.includes('that same work done off the map'));
ok('source: trailhead-work SKILL.md drops the old "that same work done off the map" phrasing', !workSkillSourceFor179.includes('that same work done off the map'));
ok('source: capture.md never describes quick <n> as off the map', !offMapQuickN.test(captureSource));
ok('source: session-handoff.md never describes quick <n> as off the map (outside the explicit never-clause)', !offMapQuickN.test(sessionHandoffMinusClause));
ok('source: trailhead-work SKILL.md never describes quick <n> as off the map', !offMapQuickN.test(workSkillSourceFor179));
ok('source: session-handoff.md explicitly says never to describe quick <n> on a map ticket as off the map',
  neverDescribeClause.test(sessionHandoffSource));
ok('source: capture.md says a map ticket stays on its map', /a map ticket stays on its map/.test(captureSource));
const ticketEnginesSourceFor179 = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-work', 'references', 'ticket-engines.md'), 'utf8');
ok('source: ticket-engines.md never labels quick generically as off-map', !/`quick`[^.\n]{0,40}off-map/.test(ticketEnginesSourceFor179));

// --- quick is the lighter path, never "just without splitting" --------------
// Source-level invariant: wherever a next-step suggestion characterizes quick,
// it names what quick is for (the lighter path: always size-triaged, offers to
// skip the heavy steps on a small change, no map book-keeping), with no-split
// as a side note. The old "only the no-split alternative" / "same work as
// work, without split" framing made agents tell users quick merely avoids
// splitting.
const dispatcherSourceForQuick = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead', 'SKILL.md'), 'utf8');
ok('source: capture.md drops the "only the no-split alternative" framing', !/only\*\* the no-split alternative/.test(captureSource));
ok('source: session-handoff.md drops the "as the no-split alternative" framing', !sessionHandoffSource.includes('as the no-split alternative'));
ok('source: dispatcher SKILL.md drops the "as the no-split alternative" framing', !dispatcherSourceForQuick.includes('as the no-split alternative'));
ok('source: session-handoff.md example drops "lo stesso lavoro di `work`, senza split"', !sessionHandoffSource.includes('lo stesso lavoro di `work`, senza split'));
ok('source: capture.md says quick offers to skip the heavy steps on a small change', /quick <n>`[\s\S]{0,400}skip the heavy steps/.test(captureSource));
ok('source: capture.md forbids describing quick as merely avoiding a split', /never as merely "without splitting"/.test(captureSource));
ok('source: session-handoff.md forbids describing quick as merely avoiding a split', /never as merely "without splitting"/.test(sessionHandoffSource));
ok('source: session-handoff.md example renders quick as the lighter path', /> - oppure `\/trailhead:quick[^\n]*percorso leggero/.test(sessionHandoffSource));

// --- #181: scope code review and verify to the ticket's own commits ---------
// Source-level invariant: Code review and Goal-backward verification scope to
// the commits carrying this ticket's `Refs: #<n>` trailer (the "Ticket diff"
// rule), never a `<base>...HEAD` range, which under `git: main` sweeps in
// other tickets' interleaved commits. code-review.md is canonical; verify.md
// restates the same pinned command inline. Also a behavioral pin: run the
// extracted command against a scratch repo with decoys, an interleaved
// foreign commit, and a conflicting trunk-sync merge.
const codeReviewSourcePath181 = path.join(sourceSkillsDir, '_shared', 'techniques', 'code-review.md');
const codeReviewSource181 = fs.readFileSync(codeReviewSourcePath181, 'utf8');
const verifySourcePath181 = path.join(sourceSkillsDir, '_shared', 'techniques', 'verify.md');
const verifySource181 = fs.readFileSync(verifySourcePath181, 'utf8');
const techniquesSourcePath181 = path.join(sourceSkillsDir, '_shared', 'techniques.md');
const techniquesSource181 = fs.readFileSync(techniquesSourcePath181, 'utf8');
const ticketEnginesSource181 = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-work', 'references', 'ticket-engines.md'), 'utf8');

ok("code-review.md states the Ticket diff heading sentence",
  codeReviewSource181.includes("**Ticket diff: review the ticket's own commits, never a range.**"));
ok('code-review.md contains the exact per-commit read form',
  codeReviewSource181.includes('git -C <repo> show --remerge-diff <sha>'));
ok('code-review.md does NOT contain the old range-scoped diff', !codeReviewSource181.includes('git diff <base>...HEAD'));
ok('code-review.md does NOT contain the old "pin a fixed point" phrasing', !codeReviewSource181.includes('pin a fixed point'));
ok('code-review.md states an empty set is an error', /\*\*An empty set is an error\*\*/.test(codeReviewSource181));
ok('code-review.md says the set is recomputed every round and every verify run',
  codeReviewSource181.includes('Recompute the set on every review round and every verify run'));
ok('code-review.md says the set is never collapsed into one span',
  codeReviewSource181.includes('Never collapse the set into one'));
ok('code-review.md mentions git: pr', codeReviewSource181.includes('git: pr'));
ok('code-review.md mentions trailhead/t<n>', codeReviewSource181.includes('trailhead/t<n>'));

const ticketDiffLogCmdRegex = /git -C <repo> log [^\n`]*HEAD/;
const codeReviewCmdMatch181 = codeReviewSource181.match(ticketDiffLogCmdRegex);
ok('code-review.md contains the pinned Ticket diff log command', !!codeReviewCmdMatch181);
const codeReviewLogCmd181 = codeReviewCmdMatch181 ? codeReviewCmdMatch181[0] : '';

ok('verify.md contains the same per-commit read form as code-review.md',
  verifySource181.includes('git -C <repo> show --remerge-diff <sha>'));
ok('verify.md references the Ticket diff', verifySource181.includes('**Ticket diff**'));
ok('verify.md references code-review.md as canonical', verifySource181.includes('code-review.md'));
ok('verify.md does NOT contain the old range-scoped diff', !verifySource181.includes('git diff <base>...HEAD'));

const verifyCmdMatch181 = verifySource181.match(ticketDiffLogCmdRegex);
ok('verify.md contains the pinned Ticket diff log command', !!verifyCmdMatch181);
const verifyLogCmd181 = verifyCmdMatch181 ? verifyCmdMatch181[0] : '';
ok('code-review.md and verify.md state the exact same log command',
  codeReviewLogCmd181 !== '' && codeReviewLogCmd181 === verifyLogCmd181);

const verifyStepLines181 = ticketEnginesSource181.split('\n').filter((l) => l.trim().startsWith('4. **Verify**'));
ok('ticket-engines.md has exactly two Verify (step 4) lines', verifyStepLines181.length === 2);
ok('both Verify step lines reference the Ticket diff', verifyStepLines181.every((l) => l.includes('**Ticket diff**')));
ok('ticket-engines.md does NOT contain the old range-scoped diff', !ticketEnginesSource181.includes('git diff <base>...HEAD'));

ok("techniques.md index row updates Code review to the ticket's own commits",
  techniquesSource181.includes("review the ticket's own commits (its `Refs: #<n>` set) on 4 axes"));

for (const [label, src] of [
  ['code-review.md', codeReviewSource181],
  ['verify.md', verifySource181],
  ['ticket-engines.md', ticketEnginesSource181],
  ['techniques.md', techniquesSource181],
]) {
  ok(`${label} has no em-dash`, !src.includes('\u2014'));
}

// --- #181 behavioral pin: build a scratch repo and run the extracted command -
function gitEnv181(extra = {}) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Trailhead Test',
    GIT_AUTHOR_EMAIL: 'trailhead-test@example.com',
    GIT_COMMITTER_NAME: 'Trailhead Test',
    GIT_COMMITTER_EMAIL: 'trailhead-test@example.com',
    LC_ALL: 'C',
    ...extra,
  };
}
function git181(dir, args, extraEnv = {}) {
  return execFileSync('git', ['-C', dir, ...args], { env: gitEnv181(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function commit181(dir, message, dateStr) {
  git181(dir, ['add', '-A']);
  git181(dir, ['commit', '-m', message], { GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr });
  return git181(dir, ['rev-parse', 'HEAD']).trim();
}

const t181Repo = mktmp();
git181(t181Repo, ['init', '-b', 'main']);
const fFile181 = path.join(t181Repo, 'f.txt');
const D181 = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;

fs.writeFileSync(fFile181, 'a\n');
const shaA181 = commit181(t181Repo, 'feat: a\n\nRefs: #18', D181(1));

fs.writeFileSync(path.join(t181Repo, 'decoy-b.txt'), 'b\n');
commit181(t181Repo, 'feat: b\n\nRefs: #181', D181(2));

fs.writeFileSync(path.join(t181Repo, 'decoy-c.txt'), 'c\n');
commit181(t181Repo, 'feat: c\n\nRefs: #1800', D181(3));

fs.writeFileSync(path.join(t181Repo, 'decoy-d.txt'), 'd\n');
commit181(t181Repo, 'feat: d\n\nmentions Refs: #18 inline\nRefs: #99', D181(4));

fs.writeFileSync(fFile181, 'foreign\n');
commit181(t181Repo, 'feat: foreign\n\nRefs: #99', D181(5));

git181(t181Repo, ['checkout', '-b', 'side']);
fs.writeFileSync(fFile181, 'side-edit\n');
fs.writeFileSync(path.join(t181Repo, 'foreign.txt'), 'foreign-file\n');
commit181(t181Repo, 'chore: side edit', D181(6));

git181(t181Repo, ['checkout', 'main']);
fs.writeFileSync(fFile181, 'main-edit\n');
const shaF181 = commit181(t181Repo, 'fix: e\n\nRefs: #18', D181(7));

let mergeConflicted181 = false;
try {
  git181(t181Repo, ['merge', 'side', '--no-commit', '--no-ff']);
} catch {
  mergeConflicted181 = true;
}
ok('#181 scratch repo: the trunk-sync merge actually conflicts on f.txt', mergeConflicted181);
fs.writeFileSync(fFile181, 'RESOLVED\n');
git181(t181Repo, ['add', 'f.txt', 'foreign.txt']);
const shaMerge181 = commit181(t181Repo, 'merge: sync\n\nRefs: #18', D181(8));

ok('#181 scratch repo: merge sha differs from the fix sha', shaMerge181 !== shaF181);

function runShellGit181(cmd, extraEnv = {}) {
  return execFileSync('sh', ['-c', cmd], { env: gitEnv181(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

const substituted181 = (cmd, n) => cmd.replace(/<repo>/g, JSON.stringify(t181Repo)).replace(/<n>/g, String(n));

const fixedPatternTypeEnv181 = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'grep.patternType',
  GIT_CONFIG_VALUE_0: 'fixed',
};

const out18_181 = runShellGit181(substituted181(codeReviewLogCmd181, 18), fixedPatternTypeEnv181);
const lines18_181 = out18_181.split('\n').filter((l) => l.length > 0);
ok('#181 log command returns exactly [a, f, merge] oldest-first for #18, even under grep.patternType=fixed',
  lines18_181.length === 3 && lines18_181[0] === shaA181 && lines18_181[1] === shaF181 && lines18_181[2] === shaMerge181);

const out7_181 = runShellGit181(substituted181(codeReviewLogCmd181, 7), fixedPatternTypeEnv181);
ok('#181 log command returns empty output for a ticket with no commits', out7_181.trim() === '');

const remergeCmd181 = 'git -C <repo> show --remerge-diff <sha>'
  .replace('<repo>', JSON.stringify(t181Repo))
  .replace('<sha>', shaMerge181);
const remergeOut181 = runShellGit181(remergeCmd181);
ok('#181 --remerge-diff on the merge shows the resolution hunk', remergeOut181.includes('RESOLVED'));
ok('#181 --remerge-diff on the merge does NOT show the foreign file the merge pulled in cleanly',
  !remergeOut181.includes('foreign.txt'));

// --- #151: eager edge drop at close (superseded / out-of-scope only) ---------
// Source-level invariant: closing a ticket as trailhead:superseded or
// trailhead:out-of-scope drops its native sub-issue edge at close (reusing the
// 404-tolerant DELETE from #150), while a genuinely-resolved close leaves the
// edge in place (it feeds GitHub's native progress bar; /trailhead:prune is its
// only shedder). Asserts the canonical rule, every operative close site, and a
// NEGATIVE invariant on the resolved-close path.
const substrateCommandsSource = fs.readFileSync(path.join(sourceSkillsDir, '_shared', 'substrate-commands.md'), 'utf8');
ok('source: substrate-commands.md documents the eager edge drop at close (superseded / out-of-scope only)',
  /[Ee]ager edge drop at close \(superseded \/ out-of-scope only\)/.test(substrateCommandsSource));
ok('source: substrate-commands.md fixes the label -> DELETE -> close ordering for the eager drop',
  /apply the state label first, then DELETE the edge, then `gh issue close`/.test(substrateCommandsSource));
ok('source: substrate-commands.md eager drop excludes resolved closes (progress bar / prune)',
  // Proximity-scoped so each conjunct is load-bearing on the NEW paragraph's own
  // text, not on the pre-existing "progress bar" mentions elsewhere in the file.
  /Only these two closes shed eagerly[\s\S]{0,300}progress bar/.test(substrateCommandsSource) &&
  /Resolved edges stay[\s\S]{0,160}`\/trailhead:prune`'s job/.test(substrateCommandsSource));

const substrateSource = fs.readFileSync(path.join(sourceSkillsDir, '_shared', 'substrate.md'), 'utf8');
ok('source: substrate.md out-of-scope label notes the edge is dropped at close',
  /`trailhead:out-of-scope`[\s\S]{0,260}native sub-issue edge is dropped at close/.test(substrateSource));
ok('source: substrate.md superseded label notes the edge is dropped at close',
  /`trailhead:superseded`[\s\S]{0,260}native sub-issue edge is dropped at close/.test(substrateSource));

const teamworkSource = fs.readFileSync(path.join(sourceSkillsDir, '_shared', 'teamwork.md'), 'utf8');
ok('source: teamwork.md supersede close drops the native sub-issue edge',
  /Supersede the original[\s\S]{0,400}drop its native sub-issue edge from the map/.test(teamworkSource));

const workSkillSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-work', 'SKILL.md'), 'utf8');
ok('source: trailhead-work SKILL.md out-of-scope close drops the native sub-issue edge',
  /out of scope\*\* \(label, then \*\*drop its native sub-issue edge\*\*/.test(workSkillSource));

const inboxSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-chart', 'references', 'inbox.md'), 'utf8');
ok('source: inbox.md out-of-scope close drops the native sub-issue edge',
  /`trailhead:out-of-scope`, \*\*drop its native sub-issue edge\*\*/.test(inboxSource));
ok('source: inbox.md dropped-fog close drops any native sub-issue edge',
  /drop any native sub-issue edge to reclaim a slot/.test(inboxSource));

// NEGATIVE invariant: the resolved-close paths (build/bug Resolve) must NOT
// carry an eager edge-drop instruction; resolved edges stay for the progress bar.
const ticketEnginesSource = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-work', 'references', 'ticket-engines.md'), 'utf8');
ok('source: ticket-engines.md resolved-close path does NOT drop the native sub-issue edge',
  !/drop (its|any) native sub-issue edge/.test(ticketEnginesSource));

// --- #178: drive-mode ask (AI-driven vs human-driven) at every UAT start -----
// Single-sourced in techniques/acceptance-testing.md as the "Drive mode" bullet;
// every other call-site (ticket-engines.md, auto.md, choices.md) references it
// by name ("drive-mode ask") rather than restating its clauses. Extract the
// bullet's own span (its marker line through the end of its indented `  - `
// sub-bullets) and pin each clause inside that span, mirroring the #139/#146
// source-level anti-drift style.
function extractBulletSpan(source, markerLine) {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(markerLine));
  if (startIdx === -1) return '';
  let endIdx = startIdx + 1;
  while (endIdx < lines.length && lines[endIdx].startsWith('  - ')) endIdx++;
  return lines.slice(startIdx, endIdx).join('\n');
}
const driveModeMarker = '- **Drive mode: ask who drives the UAT.**';
const acceptanceTestingSourcePath = path.join(sourceSkillsDir, '_shared', 'techniques', 'acceptance-testing.md');
const acceptanceTestingSource = fs.readFileSync(acceptanceTestingSourcePath, 'utf8');
const driveModeSpan = extractBulletSpan(acceptanceTestingSource, driveModeMarker);
ok('source: acceptance-testing.md carries the Drive-mode bullet', driveModeSpan.length > 0);
for (const phrase of [
  '**before any step runs**',
  '**wait for an explicit answer**',
  '**silence or an ambiguous reply re-asks**',
  '**One-path skip**',
  '**state the reason in one line**',
  'VERIFY',
  'only for the steps it cannot perform',
  'runs unchanged',
  '**in both modes**',
  'acceptance.browser: off',
  'without the confirm gate',
]) {
  ok(`source: acceptance-testing.md Drive-mode span pins "${phrase}"`, driveModeSpan.includes(phrase));
}
// The three start paths.
ok('source: Drive-mode span names build/bug Verify as a start path', driveModeSpan.includes('Verify'));
ok("source: Drive-mode span names the Pending-UAT guard's option (a) as a start path", driveModeSpan.includes('Pending-UAT guard'));
ok('source: Drive-mode span names a UAT follow-up (UAT of:) as a start path', driveModeSpan.includes('UAT of:'));
// The three performability classes.
ok('source: Drive-mode span names the physical-device/hardware performability class', driveModeSpan.includes('a physical device or hardware'));
ok('source: Drive-mode span names the credentials/accounts performability class', driveModeSpan.includes('credentials or accounts it does not hold'));
ok('source: Drive-mode span names the human sensory-judgement performability class', driveModeSpan.includes('a human sensory judgement'));

// The "Pending UAT must stay tracked" bullet references the ask for BOTH (a)
// run-now and (b) the follow-up (grouped: two mentions in the same bullet).
const pendingUatBulletMarker = '**Pending UAT must stay tracked: a closed ticket is not tracking.**';
const pendingUatLine = acceptanceTestingSource.split('\n').find((l) => l.includes(pendingUatBulletMarker)) || '';
ok('source: Pending-UAT bullet exists', pendingUatLine.length > 0);
ok('source: Pending-UAT bullet references the drive-mode ask for both (a) and the follow-up',
  (pendingUatLine.match(/drive-mode ask/g) || []).length >= 2);

// Single-source anti-drift: the bullet's own signature phrase appears in
// exactly one file across the whole skills tree (mirrors #146).
const driveModeSignature = 'ask who drives the UAT';
const driveModeSignatureFiles = mdFilesUnder(sourceSkillsDir).filter((f) => fs.readFileSync(f, 'utf8').includes(driveModeSignature));
ok('source: "ask who drives the UAT" signature appears in exactly one skills-tree file', driveModeSignatureFiles.length === 1);
ok('source: that one file is techniques/acceptance-testing.md', driveModeSignatureFiles.length === 1 && driveModeSignatureFiles[0] === acceptanceTestingSourcePath);

// The Codex install projects acceptance-testing.md with the Drive-mode bullet.
ok('codex: skills/_shared/techniques/acceptance-testing.md is projected with the Drive-mode bullet',
  fs.readFileSync(path.join(codexDir, 'skills', '_shared', 'techniques', 'acceptance-testing.md'), 'utf8').includes(driveModeMarker));

// --- #178 (2/4): route UAT follow-ups by pointer, engines through the ask ----
// A new type-independent section, keyed on the `UAT of:` pointer rather than
// the ticket's type label, must sit before the first per-type `## `decision``
// heading (work/quick/auto all dispatch through this file).
function extractSection(source, headingMarker) {
  const start = source.indexOf(headingMarker);
  if (start === -1) return '';
  const rest = source.slice(start + headingMarker.length);
  const nextHeadingIdx = rest.search(/\n## /);
  return headingMarker + (nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx));
}
const uatFollowupHeadingMarker = '## UAT follow-ups (any type)';
const decisionHeadingMarker = '## `decision`';
ok('source: ticket-engines.md has the "UAT follow-ups (any type)" section', ticketEnginesSource.includes(uatFollowupHeadingMarker));
ok('source: the UAT follow-ups section precedes the first `decision` heading',
  ticketEnginesSource.indexOf(uatFollowupHeadingMarker) !== -1 &&
  ticketEnginesSource.indexOf(uatFollowupHeadingMarker) < ticketEnginesSource.indexOf(decisionHeadingMarker));
const uatFollowupSection = extractSection(ticketEnginesSource, uatFollowupHeadingMarker);
for (const phrase of ['UAT of:', 'whatever its type label', 'trailhead:seed', '`VERIFY` comment on the follow-up', 'acceptance-testing.md']) {
  ok(`source: the UAT follow-ups section contains "${phrase}"`, uatFollowupSection.includes(phrase));
}

// Both the build and bug engines' Verify step, and both Resolve steps'
// Pending-UAT guard, must route through the drive-mode ask by name (the
// single source stays acceptance-testing.md; these reference it).
const verifyStepLines = ticketEnginesSource.split('\n').filter((l) => l.trim().startsWith('4. **Verify**'));
ok('source: ticket-engines.md carries both the build and bug Verify step lines', verifyStepLines.length === 2);
ok('source: both Verify step lines reference the drive-mode ask', verifyStepLines.length === 2 && verifyStepLines.every((l) => l.includes('drive-mode ask')));

const pendingUatGuardLines = ticketEnginesSource.split('\n').filter((l) => l.includes('Pending-UAT guard (before the close)'));
ok('source: ticket-engines.md carries both build and bug Pending-UAT guard lines', pendingUatGuardLines.length === 2);
ok('source: both Pending-UAT guard lines reference the drive-mode ask', pendingUatGuardLines.length === 2 && pendingUatGuardLines.every((l) => l.includes('drive-mode ask')));

// auto.md mentions the ask, AND (plan-review addition) a single localized span
// states its outcomes TOGETHER: takes it without the confirm gate, picks
// AI-driven when any step is agent-performable, never fakes a human-only step,
// and sets the ticket aside listing them in the run-end summary.
const autoSourcePath = path.join(sourceSkillsDir, 'trailhead-work', 'references', 'auto.md');
const autoSource = fs.readFileSync(autoSourcePath, 'utf8');
ok('source: auto.md mentions the drive-mode ask', autoSource.includes('drive-mode ask'));
ok('source: auto.md states the drive-mode-ask outcomes together (grouped, not scattered)',
  /drive-mode ask[\s\S]{0,120}without the confirm gate[\s\S]{0,300}AI-driven[\s\S]{0,200}agent-performable[\s\S]{0,300}never fake[\s\S]{0,300}run-end summary/.test(autoSource));

// choices.md carries the call-site row for the drive-mode ask.
const choicesSourcePath = path.join(sourceSkillsDir, '_shared', 'choices.md');
const choicesSource = fs.readFileSync(choicesSourcePath, 'utf8');
ok('source: choices.md call-site table carries the drive-mode ask row', /\|[^\n]*[Dd]rive-mode ask[^\n]*\|/.test(choicesSource));

// --- #178 (3/4): acceptance.browser off keeps AI-driven UAT via commands ----
const configReferencePath = path.join(sourceSkillsDir, '_shared', 'configuration-reference.md');
const configReferenceSource = fs.readFileSync(configReferencePath, 'utf8');
ok('source: configuration-reference.md acceptance.browser explanation clarifies off still runs AI-driven checks via commands',
  /\*\*acceptance\.browser\.\*\*[\s\S]{0,1000}`off`[\s\S]{0,300}AI-driven[\s\S]{0,300}commands/.test(configReferenceSource));
ok('source: configuration-reference.md guided-setup menu no longer labels the off option "Guided UAT only"',
  !configReferenceSource.includes('Guided UAT only'));
ok('source: configuration-reference.md guided-setup menu relabels the off option "No browser"',
  /Acceptance testing[\s\S]{0,200}No browser/.test(configReferenceSource));

// --- #178 (4/4): mirror the UAT drive-mode ask in READMEs and /docs ---------
const readmeSource = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const readmeItSource = fs.readFileSync(path.join(repoRoot, 'README.it.md'), 'utf8');
const ticketTypesSource = fs.readFileSync(path.join(repoRoot, 'site', 'src', 'content', 'docs', 'docs', 'ticket-types.md'), 'utf8');
const workflowSource = fs.readFileSync(path.join(repoRoot, 'site', 'src', 'content', 'docs', 'docs', 'workflow.md'), 'utf8');
const configurationMdxSource = fs.readFileSync(path.join(repoRoot, 'site', 'src', 'content', 'docs', 'docs', 'configuration.mdx'), 'utf8');

ok('README.md build row frames acceptance testing as asking who drives', /🔨 `build`[\s\S]{0,400}who drives/.test(readmeSource));
ok('README.md worked example frames the login-flow acceptance as AI-driven', /asked who drives[\s\S]{0,100}AI-driven/.test(readmeSource));
ok('README.md acceptance.browser row says off still runs AI-driven checks', /`acceptance\.browser`[\s\S]{0,400}AI-driven/.test(readmeSource));

ok('README.it.md build row frames acceptance testing as asking who drives (chi guida)', /🔨 `build`[\s\S]{0,400}chi guida/.test(readmeItSource));
ok('README.it.md worked example frames the login-flow acceptance as AI-driven', /chi guida[\s\S]{0,100}AI-driven/.test(readmeItSource));
ok('README.it.md acceptance.browser row says off still runs AI-driven checks', /`acceptance\.browser`[\s\S]{0,400}AI-driven/.test(readmeItSource));

ok('site ticket-types.md build row frames acceptance testing as asking who drives', /`build`[\s\S]{0,400}who drives/.test(ticketTypesSource));
ok('site workflow.md worked example frames the login-flow acceptance as AI-driven', /asked who drives[\s\S]{0,100}AI-driven/.test(workflowSource));
ok('site configuration.mdx acceptance.browser row says off still runs AI-driven checks', /`acceptance\.browser`[\s\S]{0,400}AI-driven/.test(configurationMdxSource));

// --- #178 fix: keep the drive-mode ask ahead of URL resolution --------------
// Code review found the acceptance.browser clause made the drive-mode ask
// CONDITIONAL on URL resolution ("fall back to the drive-mode ask ... only
// when none can be determined"), contradicting the single source
// (acceptance-testing.md: the ask fires before any step runs, always) and
// conflating it with the URL-not-found fallback (ask for the URL, or guided
// UAT). The clause must instead state the ask always comes first and never
// gate it on URL detection.
ok('source: configuration-reference.md acceptance.browser clause does NOT make the drive-mode ask conditional on URL resolution',
  !configReferenceSource.includes('fall back to the drive-mode ask'));
ok('source: configuration-reference.md acceptance.browser clause states the drive-mode ask always comes first',
  /\*\*acceptance\.browser\.\*\*[\s\S]{0,200}drive-mode ask[\s\S]{0,120}always comes first/.test(configReferenceSource));

// The run-end summary's enumerated set-aside category list is missing the new
// human-only-UAT-steps class (added by #178); it must be listed there too,
// matching the wording already used for it at line 29 ("human-only steps").
const runEndSummarySection = extractSection(autoSource, '## Run-end summary');
ok('source: auto.md Run-end summary section exists', runEndSummarySection.length > 0);
ok('source: auto.md Run-end summary "what remains" list includes human-only UAT steps',
  /what remains[\s\S]{0,400}human-only UAT steps/.test(runEndSummarySection));

// --- codex hooks (#29) --------------------------------------------------------
const codexHooksJsonPath = path.join(codexDir, 'hooks.json');
ok('codex: hooks.json exists', fs.existsSync(codexHooksJsonPath));
const codexHooksJson = JSON.parse(fs.readFileSync(codexHooksJsonPath, 'utf8'));
const codexHooksJsonStr = JSON.stringify(codexHooksJson);
ok('codex: hooks.json registers commit-guard under PreToolUse', codexHooksJsonStr.includes('trailhead-commit-guard.js') &&
  (codexHooksJson.hooks.PreToolUse || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-commit-guard.js'))));
ok('codex: hooks.json registers secret-guard under PreToolUse', (codexHooksJson.hooks.PreToolUse || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-secret-guard.js'))));
ok('codex: hooks.json registers injection-scanner under PostToolUse', (codexHooksJson.hooks.PostToolUse || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-issue-injection-scanner.js'))));
ok('codex: hooks.json registers check-update under SessionStart', (codexHooksJson.hooks.SessionStart || []).some((g) => (g.hooks || []).some((h) => h.command.includes('trailhead-check-update.js'))));

ok('codex: skills/trailhead/hooks/trailhead-secret-guard.js exists', fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')));
ok('codex: skills/trailhead/hooks/lib/commit-message-check.js exists (commit-guard require target)',
  fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'lib', 'commit-message-check.js')));
ok('codex: skills/trailhead/hooks/lib/gh-subcommand.js exists (body-guard/secret-guard require target, #153)',
  fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'lib', 'gh-subcommand.js')));
ok('codex: skills/trailhead/hooks/lib/model-defaults-review.js exists (check-update require target, #186)',
  fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'lib', 'model-defaults-review.js')));
ok('codex: skills/trailhead/hooks/lib/model-defaults.json exists (#186)',
  fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'lib', 'model-defaults.json')));
// #169: search-guard is Claude-Code-specific (it only prevents arming
// Claude's Read() deny rule under bypass permissions, a mechanism Codex
// lacks), so it must neither be registered nor copied on a Codex install.
ok('codex: hooks.json does NOT register search-guard under any event', !codexHooksJsonStr.includes('trailhead-search-guard.js'));
ok('codex: skills/trailhead/hooks/trailhead-search-guard.js does NOT exist',
  !fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'trailhead-search-guard.js')));
ok('codex: skills/trailhead/hooks/lib/shell-scan.js still exists (secret-read-guard require target)',
  fs.existsSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'lib', 'shell-scan.js')));

const codexConfigTomlPath = path.join(codexDir, 'config.toml');
ok('codex: config.toml exists', fs.existsSync(codexConfigTomlPath));
ok('codex: config.toml enables hooks feature', fs.readFileSync(codexConfigTomlPath, 'utf8').includes('hooks = true'));
// All 8 agents are always projected uniformly (pinned or pin-less), so
// multi_agent_v2 is ON even with no models.codex.* set (this install,
// repoRoot, sets none): the adapter §D registry is always present.
ok('codex: config.toml enables multi_agent_v2 even with no models.codex.* pins projected',
  fs.readFileSync(codexConfigTomlPath, 'utf8').includes('multi_agent_v2 = true'));

const codexAgentsDirPath = path.join(codexDir, 'agents');
const noPinFixTomlPath = path.join(codexAgentsDirPath, 'trailhead-fix.toml');
const noPinMapTomlPath = path.join(codexAgentsDirPath, 'trailhead-codebase-map.toml');
ok('codex: trailhead-fix.toml is projected with no models.codex.* set', fs.existsSync(noPinFixTomlPath));
ok('codex: trailhead-codebase-map.toml is projected with no models.codex.* set', fs.existsSync(noPinMapTomlPath));
ok('codex: trailhead-fix.toml is pin-less (no model = line) with no models.codex.* set',
  fs.existsSync(noPinFixTomlPath) && !/^model = /m.test(fs.readFileSync(noPinFixTomlPath, 'utf8')));

assertModelDefaultsLibLayout('codex copy', path.join(codexDir, 'skills', '_shared'));

// --- codex --symlink: link verbatim artifacts (hooks + templates), keep skills projected ---
const codexSymDir = mktmp();
runInstaller([`--codex`, `--symlink`, `--dir=${codexSymDir}`]);
ok('codex symlink: skills/trailhead/hooks/trailhead-secret-guard.js is a symlink',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('codex symlink: skills/trailhead/hooks/lib/commit-message-check.js is a symlink',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'lib', 'commit-message-check.js')).isSymbolicLink());
ok('codex symlink: skills/trailhead/templates is a symlink',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'templates')).isSymbolicLink());
ok('codex symlink: a hook symlink resolves into the package source',
  fs.realpathSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')) ===
  fs.realpathSync(path.join(repoRoot, 'plugins', 'trailhead', 'hooks', 'trailhead-secret-guard.js')));
ok('codex symlink: converted SKILL.md stays a regular file (projected, not linked)',
  !fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'SKILL.md')).isSymbolicLink());
// Reinstall over the existing symlink install must not throw (EEXIST guard).
runInstaller([`--codex`, `--symlink`, `--dir=${codexSymDir}`]);
ok('codex symlink: reinstall over existing symlinks succeeds',
  fs.lstatSync(path.join(codexSymDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
// Default (copy) codex install keeps hooks/templates as real files, not symlinks.
ok('codex copy: hooks are regular files (not symlinks)',
  !fs.lstatSync(path.join(codexDir, 'skills', 'trailhead', 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('codex copy: templates is a regular dir (not a symlink)',
  !fs.lstatSync(path.join(codexDir, 'skills', 'trailhead', 'templates')).isSymbolicLink());

assertModelDefaultsLibLayout('codex symlink', path.join(codexSymDir, 'skills', '_shared'));

// --- codex agent TOML projection (#38, #88) -------------------------------------
// With NO models.codex.* set, a codex install still projects all 8 agents
// uniformly, pin-less (uniform projection, #88), never zero. Install from an
// isolated cwd whose .trailhead/config.json sets no models.codex.*, not
// repoRoot (whose own config now pins models.codex.*, so it would project
// pinned TOMLs rather than pin-less ones).
const unsetProjectDir = mktmp();
fs.mkdirSync(path.join(unsetProjectDir, '.trailhead'), { recursive: true });
fs.writeFileSync(
  path.join(unsetProjectDir, '.trailhead', 'config.json'),
  JSON.stringify({ models: {} }, null, 2) + '\n'
);
const unsetCodexHomeDir = mktmp();
runInstaller([`--codex`, `--dir=${unsetCodexHomeDir}`], { cwd: unsetProjectDir });
ok('codex: all 8 trailhead-*.toml exist under agents/ even with models.codex.* unset', (() => {
  const dir = path.join(unsetCodexHomeDir, 'agents');
  if (!fs.existsSync(dir)) return false;
  const tomls = fs.readdirSync(dir).filter((f) => /^trailhead-.*\.toml$/.test(f));
  return tomls.length === 8;
})());
ok('codex: every trailhead-*.toml is pin-less when models.codex.* is unset', (() => {
  const dir = path.join(unsetCodexHomeDir, 'agents');
  const tomls = fs.readdirSync(dir).filter((f) => /^trailhead-.*\.toml$/.test(f));
  return tomls.every((f) => !/^model = /m.test(fs.readFileSync(path.join(dir, f), 'utf8')));
})());

// --- codex migration (#46): install over old prompt shims sweeps them --------
const migCodexDir = mktmp();
fs.mkdirSync(path.join(migCodexDir, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(migCodexDir, 'prompts', 'trailhead.md'), 'stale bare shim\n');
fs.writeFileSync(path.join(migCodexDir, 'prompts', 'trailhead-work.md'), 'stale verb shim\n');
runInstaller([`--codex`, `--dir=${migCodexDir}`]);
ok('codex migration: stale prompts/trailhead.md swept on install', !fs.existsSync(path.join(migCodexDir, 'prompts', 'trailhead.md')));
ok('codex migration: stale prompts/trailhead-work.md swept on install', !fs.existsSync(path.join(migCodexDir, 'prompts', 'trailhead-work.md')));
ok('codex migration: per-verb skill projected in its place', fs.existsSync(path.join(migCodexDir, 'skills', 'trailhead-work', 'SKILL.md')));

// codex migration: a stale trailhead-owned skill dir (pre-split monolith /
// removed cluster) is swept on reinstall; a co-tenant skill is preserved.
const migCodexSkillDir = mktmp();
runInstaller([`--codex`, `--dir=${migCodexSkillDir}`]);
fs.mkdirSync(path.join(migCodexSkillDir, 'skills', 'trailhead-monolith'), { recursive: true });
fs.writeFileSync(path.join(migCodexSkillDir, 'skills', 'trailhead-monolith', 'SKILL.md'), 'stale\n');
fs.mkdirSync(path.join(migCodexSkillDir, 'skills', 'other-plugin'), { recursive: true });
fs.writeFileSync(path.join(migCodexSkillDir, 'skills', 'other-plugin', 'SKILL.md'), 'co-tenant\n');
runInstaller([`--codex`, `--dir=${migCodexSkillDir}`]);
ok('codex migration: stale trailhead-monolith skill dir swept on reinstall', !fs.existsSync(path.join(migCodexSkillDir, 'skills', 'trailhead-monolith')));
ok('codex migration: co-tenant skill preserved', fs.existsSync(path.join(migCodexSkillDir, 'skills', 'other-plugin')));

// --- codex uninstall (same tmp) ----------------------------------------------
runInstaller([`--codex`, `--dir=${codexDir}`, '--uninstall']);
ok('codex uninstall: skills/trailhead gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead')));
ok('codex uninstall: legacy trailhead engine dir gone', !fs.existsSync(path.join(codexDir, 'trailhead')));
ok('codex uninstall: per-verb skills/trailhead-work gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-work')));
ok('codex uninstall: per-verb skills/trailhead-bug gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-bug')));
ok('codex uninstall: _shared gone', !fs.existsSync(path.join(codexDir, 'skills', '_shared')));
ok('codex uninstall: cluster trailhead-view gone', !fs.existsSync(path.join(codexDir, 'skills', 'trailhead-view')));
ok('codex uninstall: hooks.json no longer contains trailhead commands', (() => {
  const h = JSON.parse(fs.readFileSync(codexHooksJsonPath, 'utf8'));
  const str = JSON.stringify(h);
  return !str.includes('trailhead-commit-guard.js') && !str.includes('trailhead-secret-guard.js') &&
    !str.includes('trailhead-issue-injection-scanner.js') && !str.includes('trailhead-check-update.js');
})());

// --- claude regression --------------------------------------------------------
const claudeDir = mktmp();
const claudeInstallOut = String(runInstaller([`--claude`, `--dir=${claudeDir}`]));

const claudeSkillPath = path.join(claudeDir, 'skills', 'trailhead', 'SKILL.md');
ok('claude: skills/trailhead/SKILL.md exists', fs.existsSync(claudeSkillPath));
// The split ships all sibling engine skills on Claude too.
ok('claude: skills/_shared/substrate.md exists', fs.existsSync(path.join(claudeDir, 'skills', '_shared', 'substrate.md')));
for (const cl of ['trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`claude: skills/${cl}/SKILL.md exists`, fs.existsSync(path.join(claudeDir, 'skills', cl, 'SKILL.md')));
}
ok('claude: cluster ../_shared/ reference resolves', fs.existsSync(path.join(claudeDir, 'skills', 'trailhead-work', '..', '_shared', 'substrate.md')));
// #139: single-sourced "Load first, in order" shared section, projected on Claude too.
ok('claude: skills/_shared/load-first.md exists', fs.existsSync(path.join(claudeDir, 'skills', '_shared', 'load-first.md')));
ok('claude: trailhead-work/../_shared/load-first.md resolves', fs.existsSync(path.join(claudeDir, 'skills', 'trailhead-work', '..', '_shared', 'load-first.md')));
for (const cl of ['trailhead', 'trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage']) {
  ok(`claude: ${cl} SKILL.md references ../_shared/load-first.md`, fs.readFileSync(path.join(claudeDir, 'skills', cl, 'SKILL.md'), 'utf8').includes('../_shared/load-first.md'));
}

// #146: single-sourced ticket-language directive, projected on Claude too.
ok('claude: skills/_shared/ticket-language.md exists', fs.existsSync(path.join(claudeDir, 'skills', '_shared', 'ticket-language.md')));
ok('claude: trailhead-work/../_shared/ticket-language.md resolves', fs.existsSync(path.join(claudeDir, 'skills', 'trailhead-work', '..', '_shared', 'ticket-language.md')));

ok('claude: commands/trailhead/work.md exists', fs.existsSync(path.join(claudeDir, 'commands', 'trailhead', 'work.md')));
ok('claude: commands/trailhead/auto.md exists', fs.existsSync(path.join(claudeDir, 'commands', 'trailhead', 'auto.md')));
ok('claude: hooks/trailhead-commit-guard.js exists', fs.existsSync(path.join(claudeDir, 'hooks', 'trailhead-commit-guard.js')));
ok('claude: hooks/lib/commit-message-check.js exists (commit-guard require target)',
  fs.existsSync(path.join(claudeDir, 'hooks', 'lib', 'commit-message-check.js')));
ok('claude: hooks/lib/gh-subcommand.js exists (body-guard/secret-guard require target, #153)',
  fs.existsSync(path.join(claudeDir, 'hooks', 'lib', 'gh-subcommand.js')));
ok('claude: hooks/lib/model-defaults-review.js exists (check-update require target, #186)',
  fs.existsSync(path.join(claudeDir, 'hooks', 'lib', 'model-defaults-review.js')));
ok('claude: hooks/lib/model-defaults.json exists (#186)',
  fs.existsSync(path.join(claudeDir, 'hooks', 'lib', 'model-defaults.json')));

// #185: the commit-msg hook sync script ships wholesale with templates/ too.
const claudeCommitMsgSync = path.join(claudeDir, 'trailhead', 'templates', 'trailhead-commit-msg-sync.js');
ok('claude: commit-msg-sync script projected', fs.existsSync(claudeCommitMsgSync));
ok('claude: commit-msg-sync script is byte-identical to source',
  fs.readFileSync(claudeCommitMsgSync, 'utf8') === fs.readFileSync(path.join(repoRoot, 'plugins', 'trailhead', 'templates', 'trailhead-commit-msg-sync.js'), 'utf8'));
// Regression: the commit-guard does require('./lib/commit-message-check.js'), so
// it only loads if the lib was copied alongside it. Run it with a benign Bash
// payload and assert it does not crash with a missing-module error.
ok('claude: trailhead-commit-guard.js loads without MODULE_NOT_FOUND', (() => {
  let out = '';
  try {
    out = String(execFileSync(process.execPath, [path.join(claudeDir, 'hooks', 'trailhead-commit-guard.js')],
      { input: '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}', stdio: 'pipe' }));
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  return !out.includes('MODULE_NOT_FOUND') && !out.includes('Cannot find module');
})());
ok('claude: SKILL.md does not start with the codex adapter header', !fs.readFileSync(claudeSkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- claude: engine agents registered as user subagents -----------------------
// Without these under <configDir>/agents/, every technique dispatch fails and
// falls back to running inline on the session model, so the per-technique
// config.models.* split silently never applies.
const claudeAgentsDir = path.join(claudeDir, 'agents');
const expectedAgents = ['trailhead-plan', 'trailhead-executor', 'trailhead-research', 'trailhead-code-review', 'trailhead-debug', 'trailhead-fix', 'trailhead-codebase-map'];
for (const a of expectedAgents) {
  ok(`claude: agents/${a}.md placed`, fs.existsSync(path.join(claudeAgentsDir, `${a}.md`)));
}
ok('claude: agent file registers its subagent name in frontmatter',
  fs.readFileSync(path.join(claudeAgentsDir, 'trailhead-executor.md'), 'utf8').startsWith('---\nname: trailhead-executor\n'));
ok('claude: agents are real files on a copy install (not symlinks)',
  !fs.lstatSync(path.join(claudeAgentsDir, 'trailhead-plan.md')).isSymbolicLink());

assertModelDefaultsLibLayout('claude copy', path.join(claudeDir, 'skills', '_shared'));

// --- claude --symlink: dev install links hooks live too (not just skills/commands) ---
const symDir = mktmp();
runInstaller([`--claude`, `--symlink`, `--dir=${symDir}`]);
ok('claude symlink: skills/trailhead is a symlink',
  fs.lstatSync(path.join(symDir, 'skills', 'trailhead')).isSymbolicLink());
ok('claude symlink: hooks/trailhead-secret-guard.js is a symlink',
  fs.lstatSync(path.join(symDir, 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('claude symlink: hooks/lib/commit-message-check.js is a symlink',
  fs.lstatSync(path.join(symDir, 'hooks', 'lib', 'commit-message-check.js')).isSymbolicLink());
ok('claude symlink: hook symlink resolves into the package source',
  fs.realpathSync(path.join(symDir, 'hooks', 'trailhead-secret-guard.js')) ===
  fs.realpathSync(path.join(repoRoot, 'plugins', 'trailhead', 'hooks', 'trailhead-secret-guard.js')));
ok('claude symlink: a symlinked commit-guard still loads its lib (no MODULE_NOT_FOUND)', (() => {
  let out = '';
  try {
    out = String(execFileSync(process.execPath, [path.join(symDir, 'hooks', 'trailhead-commit-guard.js')],
      { input: '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}', stdio: 'pipe' }));
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  return !out.includes('MODULE_NOT_FOUND') && !out.includes('Cannot find module');
})());
// Reinstalling over an existing symlink install must not throw (EEXIST guard).
runInstaller([`--claude`, `--symlink`, `--dir=${symDir}`]);
ok('claude symlink: reinstall over existing symlinks succeeds',
  fs.lstatSync(path.join(symDir, 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());
ok('claude symlink: agents/trailhead-plan.md is a symlink',
  fs.lstatSync(path.join(symDir, 'agents', 'trailhead-plan.md')).isSymbolicLink());
ok('claude symlink: agent symlink resolves into the package source',
  fs.realpathSync(path.join(symDir, 'agents', 'trailhead-plan.md')) ===
  fs.realpathSync(path.join(repoRoot, 'plugins', 'trailhead', 'agents', 'trailhead-plan.md')));
// Default (copy) install keeps hooks as real files, not symlinks.
ok('claude copy: hooks/trailhead-secret-guard.js is a regular file (not a symlink)',
  !fs.lstatSync(path.join(claudeDir, 'hooks', 'trailhead-secret-guard.js')).isSymbolicLink());

assertModelDefaultsLibLayout('claude symlink', path.join(symDir, 'skills', '_shared'));

// --- claude migration: reinstall over an old layout sweeps stale skill dirs ---
// An old install may carry a pre-split monolith (skills/trailhead-monolith) or a
// removed cluster (skills/trailhead-legacy) the current install no longer ships.
// Reinstalling must sweep every stale trailhead-owned skill dir, while leaving a
// co-tenant plugin's own skill (skills/other-plugin) untouched.
const migClaudeDir = mktmp();
runInstaller([`--claude`, `--dir=${migClaudeDir}`]);
fs.mkdirSync(path.join(migClaudeDir, 'skills', 'trailhead-monolith'), { recursive: true });
fs.writeFileSync(path.join(migClaudeDir, 'skills', 'trailhead-monolith', 'SKILL.md'), 'stale monolith\n');
fs.mkdirSync(path.join(migClaudeDir, 'skills', 'trailhead-legacy'), { recursive: true });
fs.writeFileSync(path.join(migClaudeDir, 'skills', 'trailhead-legacy', 'SKILL.md'), 'stale cluster\n');
fs.mkdirSync(path.join(migClaudeDir, 'skills', 'other-plugin'), { recursive: true });
fs.writeFileSync(path.join(migClaudeDir, 'skills', 'other-plugin', 'SKILL.md'), 'co-tenant\n');
runInstaller([`--claude`, `--dir=${migClaudeDir}`]);
ok('claude migration: stale trailhead-monolith swept on reinstall', !fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead-monolith')));
ok('claude migration: stale trailhead-legacy cluster swept on reinstall', !fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead-legacy')));
ok('claude migration: co-tenant skill preserved (only trailhead names swept)', fs.existsSync(path.join(migClaudeDir, 'skills', 'other-plugin')));
ok('claude migration: current dispatcher present after reinstall', fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead', 'SKILL.md')));
ok('claude migration: current cluster present after reinstall', fs.existsSync(path.join(migClaudeDir, 'skills', 'trailhead-work', 'SKILL.md')));
// The agents dir gets the same name-only sweep on reinstall: a stale trailhead
// agent (renamed/removed) is swept, a co-tenant agent left alone.
fs.writeFileSync(path.join(migClaudeDir, 'agents', 'trailhead-oldagent.md'), '---\nname: trailhead-oldagent\n---\n');
fs.writeFileSync(path.join(migClaudeDir, 'agents', 'other-plugin-agent.md'), '---\nname: other-plugin-agent\n---\n');
runInstaller([`--claude`, `--dir=${migClaudeDir}`]);
ok('claude migration: stale trailhead-oldagent.md swept on reinstall', !fs.existsSync(path.join(migClaudeDir, 'agents', 'trailhead-oldagent.md')));
ok('claude migration: co-tenant agent preserved on reinstall', fs.existsSync(path.join(migClaudeDir, 'agents', 'other-plugin-agent.md')));
ok('claude migration: engine agents present after reinstall', fs.existsSync(path.join(migClaudeDir, 'agents', 'trailhead-executor.md')));

// Uninstall also sweeps a stale trailhead-owned dir the current package no
// longer ships (monolith), not just the current engineSkillDirs() set.
const uninstMigDir = mktmp();
runInstaller([`--claude`, `--dir=${uninstMigDir}`]);
fs.mkdirSync(path.join(uninstMigDir, 'skills', 'trailhead-monolith'), { recursive: true });
fs.writeFileSync(path.join(uninstMigDir, 'skills', 'trailhead-monolith', 'SKILL.md'), 'stale\n');
runInstaller([`--claude`, `--dir=${uninstMigDir}`, '--uninstall']);
ok('claude uninstall: stale trailhead-monolith swept too', !fs.existsSync(path.join(uninstMigDir, 'skills', 'trailhead-monolith')));

// --- claude uninstall: remove trailhead's lib, keep a co-tenant's -------------
// The Claude hooks/lib dir is shared with other plugins. Drop a fake co-tenant
// lib next to trailhead's, uninstall, and assert only trailhead's own lib file
// is removed (never a recursive wipe of the shared dir).
const coTenantDir = mktmp();
runInstaller([`--claude`, `--dir=${coTenantDir}`]);
const coTenantLib = path.join(coTenantDir, 'hooks', 'lib', 'other-plugin-lib.js');
fs.writeFileSync(coTenantLib, '// not trailhead\n');
runInstaller([`--claude`, `--dir=${coTenantDir}`, '--uninstall']);
ok('claude uninstall: trailhead lib removed', !fs.existsSync(path.join(coTenantDir, 'hooks', 'lib', 'commit-message-check.js')));
ok('claude uninstall: co-tenant lib preserved (no recursive wipe)', fs.existsSync(coTenantLib));

// The agents dir is shared too: a co-tenant's own agent survives uninstall,
// while trailhead's are removed by name.
const coTenantAgentDir = mktmp();
runInstaller([`--claude`, `--dir=${coTenantAgentDir}`]);
const foreignAgent = path.join(coTenantAgentDir, 'agents', 'other-plugin-agent.md');
fs.writeFileSync(foreignAgent, '---\nname: other-plugin-agent\n---\n');
ok('claude: engine agent present before uninstall', fs.existsSync(path.join(coTenantAgentDir, 'agents', 'trailhead-plan.md')));
runInstaller([`--claude`, `--dir=${coTenantAgentDir}`, '--uninstall']);
ok('claude uninstall: trailhead agents removed by name', !fs.existsSync(path.join(coTenantAgentDir, 'agents', 'trailhead-plan.md')));
ok('claude uninstall: co-tenant agent preserved (no recursive wipe)', fs.existsSync(foreignAgent));

// Uninstall removes every split skill (dispatcher + clusters + _shared) by name.
const splitDir = mktmp();
runInstaller([`--claude`, `--dir=${splitDir}`]);
runInstaller([`--claude`, `--dir=${splitDir}`, '--uninstall']);
for (const nm of ['trailhead', 'trailhead-chart', 'trailhead-work', 'trailhead-view', 'trailhead-capture', 'trailhead-manage', '_shared']) {
  ok(`claude uninstall: skills/${nm} removed`, !fs.existsSync(path.join(splitDir, 'skills', nm)));
}

const settingsPath = path.join(claudeDir, 'settings.json');
ok('claude: settings.json exists', fs.existsSync(settingsPath));
const settingsContent = fs.readFileSync(settingsPath, 'utf8');
ok('claude: settings.json references commit-guard', settingsContent.includes('trailhead-commit-guard.js'));

// --- auto-detect: exactly one CLI on $PATH -> install for it, no flag ----------
// Only a fake `codex` on $PATH: the installer must pick codex on its own.
const autoCodexDir = mktmp();
runInstaller([`--dir=${autoCodexDir}`], { env: { PATH: fakeBinDir(['codex']) } });
const autoCodexSkillPath = path.join(autoCodexDir, 'skills', 'trailhead', 'SKILL.md');
ok('auto-detect codex: skills/trailhead/SKILL.md exists', fs.existsSync(autoCodexSkillPath));
ok('auto-detect codex: SKILL.md carries the adapter header (proves codex layout)', fs.readFileSync(autoCodexSkillPath, 'utf8').includes('<codex_skill_adapter>'));
ok('auto-detect codex: did not install the Claude layout (no commands/trailhead)', !fs.existsSync(path.join(autoCodexDir, 'commands', 'trailhead')));
ok('auto-detect codex: did not install the Claude layout (no settings.json)', !fs.existsSync(path.join(autoCodexDir, 'settings.json')));

// Only a fake `claude` on $PATH: the installer must pick claude on its own.
const autoClaudeDir = mktmp();
runInstaller([`--dir=${autoClaudeDir}`], { env: { PATH: fakeBinDir(['claude']) } });
const autoClaudeSkillPath = path.join(autoClaudeDir, 'skills', 'trailhead', 'SKILL.md');
ok('auto-detect claude: skills/trailhead/SKILL.md exists', fs.existsSync(autoClaudeSkillPath));
ok('auto-detect claude: commands/trailhead/work.md exists (proves claude layout)', fs.existsSync(path.join(autoClaudeDir, 'commands', 'trailhead', 'work.md')));
ok('auto-detect claude: SKILL.md does not start with adapter header', !fs.readFileSync(autoClaudeSkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- auto-detect: ambiguous + non-interactive -> claude fallback --------------
// No CLI on $PATH and non-interactive (piped stdio): must fall back to claude.
const fallbackDir = mktmp();
runInstaller([`--dir=${fallbackDir}`], { env: { PATH: fakeBinDir([]) } });
const fallbackSkillPath = path.join(fallbackDir, 'skills', 'trailhead', 'SKILL.md');
ok('ambiguous fallback: installs the Claude layout', fs.existsSync(fallbackSkillPath));
ok('ambiguous fallback: settings.json exists (proves claude layout)', fs.existsSync(path.join(fallbackDir, 'settings.json')));
ok('ambiguous fallback: SKILL.md does not start with adapter header', !fs.readFileSync(fallbackSkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- both --codex and --claude -> hard error ----------------------------------
let bothRejected = false;
try {
  runInstaller([`--codex`, `--claude`, `--dir=${mktmp()}`]);
} catch (e) {
  bothRejected = true;
}
ok('conflicting --codex --claude is rejected', bothRejected);

// --- legacy --host= is no longer a host selector ------------------------------
// It must not silently install codex; with no real flag it auto-detects, and
// here $PATH has only claude, so a stray --host=codex still yields claude.
const legacyDir = mktmp();
runInstaller([`--host=codex`, `--dir=${legacyDir}`], { env: { PATH: fakeBinDir(['claude']) } });
const legacySkillPath = path.join(legacyDir, 'skills', 'trailhead', 'SKILL.md');
ok('legacy --host=codex is ignored (auto-detect wins)', fs.existsSync(legacySkillPath));
ok('legacy --host=codex is ignored: settings.json exists (proves claude layout)', fs.existsSync(path.join(legacyDir, 'settings.json')));
ok('legacy --host=codex is ignored: SKILL.md does not start with adapter header', !fs.readFileSync(legacySkillPath, 'utf8').startsWith('<codex_skill_adapter>'));

// --- codex agent TOML projection: a real models.codex.* pin (#38) --------------
// A temp "project" dir with .trailhead/config.json setting models.codex.execute;
// running the installer with that dir as cwd (and a separate codex-home tmp dir
// as --dir=) must project trailhead-execute.toml under <codexHome>/agents/.
const projectDir = mktmp();
fs.mkdirSync(path.join(projectDir, '.trailhead'), { recursive: true });
fs.writeFileSync(
  path.join(projectDir, '.trailhead', 'config.json'),
  JSON.stringify({ models: { codex: { execute: 'gpt-5.6-terra' } } }, null, 2) + '\n'
);
const pinCodexHomeDir = mktmp();
runInstaller([`--codex`, `--dir=${pinCodexHomeDir}`], { cwd: projectDir });

const pinnedTomlPath = path.join(pinCodexHomeDir, 'agents', 'trailhead-execute.toml');
ok('codex: models.codex.execute projects trailhead-execute.toml', fs.existsSync(pinnedTomlPath));
const pinnedTomlContent = fs.existsSync(pinnedTomlPath) ? fs.readFileSync(pinnedTomlPath, 'utf8') : '';
ok('codex: trailhead-execute.toml has the pinned model', pinnedTomlContent.includes('model = "gpt-5.6-terra"'));
ok('codex: trailhead-execute.toml has the right name', pinnedTomlContent.includes('name = "trailhead-execute"'));
// With a real pin projected, v2 IS enabled so Codex honours the agent_type registry.
const pinConfigTomlPath = path.join(pinCodexHomeDir, 'config.toml');
ok('codex: config.toml enables multi_agent_v2 when a models.codex.* pin is projected',
  fs.existsSync(pinConfigTomlPath) && fs.readFileSync(pinConfigTomlPath, 'utf8').includes('multi_agent_v2 = true'));

// Uninstall must sweep the projected TOML too, without a --dir= cwd dependency.
runInstaller([`--codex`, `--dir=${pinCodexHomeDir}`, '--uninstall']);
ok('codex uninstall: trailhead-execute.toml is gone', !fs.existsSync(pinnedTomlPath));

// --- #136: --help / -h print usage and install nothing -----------------------
// Asserts no install artifacts landed under a fresh --dir=, by checking for the
// two markers common to both host layouts (settings.json is Claude-only, but
// skills/ is written by both, so its absence proves nothing at all ran).
function nothingInstalledUnder(dir) {
  return !fs.existsSync(path.join(dir, 'settings.json')) &&
    !fs.existsSync(path.join(dir, 'skills')) &&
    !fs.existsSync(path.join(dir, 'commands')) &&
    !fs.existsSync(path.join(dir, 'agents'));
}

const helpDir = mktmp();
const helpOut = String(runInstaller([`--help`, `--dir=${helpDir}`]));
ok('--help: prints usage (mentions --uninstall)', helpOut.includes('--uninstall'));
ok('--help: prints usage (mentions --codex)', helpOut.includes('--codex'));
ok('--help: installs nothing', nothingInstalledUnder(helpDir));

const hDir = mktmp();
const hOut = String(runInstaller([`-h`, `--dir=${hDir}`]));
ok('-h: prints usage (mentions --uninstall)', hOut.includes('--uninstall'));
ok('-h: installs nothing', nothingInstalledUnder(hDir));

// --- #136: unknown flag is rejected, not silently ignored ---------------------
const unknownDir = mktmp();
let unknownRejected = false;
let unknownOut = '';
try {
  runInstaller([`--frobnicate`, `--dir=${unknownDir}`]);
} catch (e) {
  unknownRejected = true;
  unknownOut = String(e.stdout || '') + String(e.stderr || '');
}
ok('unknown flag: rejected (non-zero exit)', unknownRejected);
ok('unknown flag: error message names the bad flag', unknownOut.includes('unknown option') && unknownOut.includes('--frobnicate'));
ok('unknown flag: error output also includes usage (mentions --codex)', unknownOut.includes('--codex'));
ok('unknown flag: installs nothing', nothingInstalledUnder(unknownDir));

// Unknown flag after a valid one: proves the whole arg list is scanned, not
// just a single expected position.
const unknownAfterValidDir = mktmp();
let unknownAfterValidRejected = false;
try {
  runInstaller([`--claude`, `--bogus`, `--dir=${unknownAfterValidDir}`]);
} catch (e) {
  unknownAfterValidRejected = true;
}
ok('unknown flag after a valid flag: still rejected', unknownAfterValidRejected);
ok('unknown flag after a valid flag: installs nothing', nothingInstalledUnder(unknownAfterValidDir));

// --- #185: teamwork.md/substrate-commands.md/trailhead-work SKILL.md point at
// the commit-msg-sync script instead of the old manual copy/chmod steps -------
ok('source: teamwork.md no longer says an existing hook is never replaced',
  !teamworkSource.includes('an existing hook is never replaced'));
ok('source: teamwork.md no longer says reinstalled by hand',
  !teamworkSource.includes("until it's reinstalled by hand"));
for (const [label, src] of [
  ['teamwork.md', teamworkSource],
  ['substrate-commands.md', substrateCommandsSource],
  ['trailhead-work/SKILL.md', workSkillSource],
]) {
  ok(`source: ${label} references trailhead-commit-msg-sync.js`, src.includes('trailhead-commit-msg-sync.js'));
  ok(`source: ${label} has no em-dash`, !src.includes('—'));
}

// --- #189: script mancante / errore node -> fallback che ispeziona la hooks dir
// invece di dichiarare alla cieca "git non applica le regole" ------------------
ok('source: teamwork.md fallback resolves the hooks dir via rev-parse --git-path hooks',
  teamworkSource.includes('git -C <working-root> rev-parse --git-path hooks'));
ok('source: teamwork.md fallback classifies by the trailhead header line',
  teamworkSource.includes('// trailhead commit-msg hook (git).'));
ok('source: teamwork.md fallback checks the executable bit (test -x)',
  teamworkSource.includes('test -x'));
ok('source: teamwork.md fallback reads only the first 5 lines',
  teamworkSource.includes('first 5 lines'));
ok('source: teamwork.md fallback treats a symlinked commit-msg as foreign',
  teamworkSource.includes('symlinked `commit-msg`'));
for (const [label, src] of [
  ['trailhead-work/SKILL.md', workSkillSource],
  ['substrate-commands.md', substrateCommandsSource],
]) {
  ok(`source: ${label} mentions the missing-script hooks-dir fallback`,
    src.includes('rev-parse --git-path hooks') && /missing script or a node error|script is missing or node errors/.test(src));
  ok(`source: ${label} has no em-dash (#189)`, !src.includes('—'));
}
ok('source: teamwork.md has no em-dash (#189)', !teamworkSource.includes('—'));

// --- #182 ---------------------------------------------------------------------
// A broken install fails loudly (verifyInstall names the gap and the run exits
// non-zero, printing no "✓ trailhead installed"); a clean one still prints ✓.
// brokenPkg copies bin/ + plugins/ into a fresh tmp root (so __dirname-relative
// PKG/SRC resolution in trailhead.js still lines up) and applies a mutation
// that breaks one source artifact; runPkg drives that copy (or the real repo)
// through execFileSync without throwing on a non-zero exit.
function brokenPkg(mutate) {
  const pkgDir = mktmp();
  fs.cpSync(path.join(repoRoot, 'bin'), path.join(pkgDir, 'bin'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'plugins'), path.join(pkgDir, 'plugins'), { recursive: true });
  if (mutate) mutate(pkgDir);
  return pkgDir;
}
function runPkg(pkgDir, args, env) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(pkgDir, 'bin', 'trailhead.js'), ...args], {
      cwd: pkgDir, stdio: 'pipe', env: env || process.env,
    });
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

// (a) no engine agents at all: both hosts refuse and print no success line.
{
  const noAgentsPkg = brokenPkg((p) => fs.rmSync(path.join(p, 'plugins', 'trailhead', 'agents'), { recursive: true, force: true }));
  const claudeOut = runPkg(noAgentsPkg, ['--claude', `--dir=${mktmp()}`]);
  ok('(a) claude, no agents: non-zero exit', claudeOut.status !== 0);
  ok('(a) claude, no agents: stderr names agents', claudeOut.stderr.includes('agents'));
  ok('(a) claude, no agents: stdout has no ✓ trailhead installed', !claudeOut.stdout.includes('✓ trailhead installed'));
  const codexOut = runPkg(noAgentsPkg, ['--codex', `--dir=${mktmp()}`]);
  ok('(a) codex, no agents: non-zero exit', codexOut.status !== 0);
  ok('(a) codex, no agents: stderr names agents', codexOut.stderr.includes('agents'));
  ok('(a) codex, no agents: stdout has no ✓ trailhead installed', !codexOut.stdout.includes('✓ trailhead installed'));
}

// (b) a cluster's SKILL.md is missing from the source.
{
  const pkg = brokenPkg((p) => fs.rmSync(path.join(p, 'plugins', 'trailhead', 'skills', 'trailhead-view', 'SKILL.md'), { force: true }));
  const out = runPkg(pkg, ['--claude', `--dir=${mktmp()}`]);
  ok('(b) missing cluster SKILL.md: non-zero exit', out.status !== 0);
  ok('(b) missing cluster SKILL.md: stderr names trailhead-view/SKILL.md', out.stderr.includes('trailhead-view/SKILL.md'));
}

// (c) the shared core is missing a file.
{
  const pkg = brokenPkg((p) => fs.rmSync(path.join(p, 'plugins', 'trailhead', 'skills', '_shared', 'substrate.md'), { force: true }));
  const out = runPkg(pkg, ['--claude', `--dir=${mktmp()}`]);
  ok('(c) missing _shared/substrate.md: non-zero exit', out.status !== 0);
  ok('(c) missing _shared/substrate.md: stderr names _shared/substrate.md', out.stderr.includes('_shared/substrate.md'));
}

// (d) a hook script source is missing, fresh dir: named cleanly, no ENOENT stack.
const missingBodyGuardPkg = brokenPkg((p) => fs.rmSync(path.join(p, 'plugins', 'trailhead', 'hooks', 'trailhead-body-guard.js'), { force: true }));
{
  const out = runPkg(missingBodyGuardPkg, ['--claude', `--dir=${mktmp()}`]);
  ok('(d) missing hook source, fresh dir: non-zero exit', out.status !== 0);
  ok('(d) missing hook source, fresh dir: stderr names trailhead-body-guard.js', out.stderr.includes('trailhead-body-guard.js'));
  ok('(d) missing hook source, fresh dir: no ENOENT stack', !out.stderr.includes('ENOENT'));
}

// (e) reinstalling that same broken package over a prior clean install removes
// the stale hook file rather than leaving it behind, on both hosts.
{
  const xDir = mktmp();
  runInstaller([`--claude`, `--dir=${xDir}`]);
  const out = runPkg(missingBodyGuardPkg, ['--claude', `--dir=${xDir}`]);
  ok('(e) claude reinstall over an old install: non-zero exit', out.status !== 0);
  ok('(e) claude reinstall: stderr names trailhead-body-guard.js', out.stderr.includes('trailhead-body-guard.js'));
  ok('(e) claude reinstall: the stale hook file is gone', !fs.existsSync(path.join(xDir, 'hooks', 'trailhead-body-guard.js')));

  const wDir = mktmp();
  runInstaller([`--codex`, `--dir=${wDir}`]);
  const outCodex = runPkg(missingBodyGuardPkg, ['--codex', `--dir=${wDir}`]);
  ok('(e) codex reinstall over an old install: non-zero exit', outCodex.status !== 0);
  ok('(e) codex reinstall: stderr names trailhead-body-guard.js', outCodex.stderr.includes('trailhead-body-guard.js'));
  ok('(e) codex reinstall: the stale hook file is gone', !fs.existsSync(path.join(wDir, 'skills', 'trailhead', 'hooks', 'trailhead-body-guard.js')));
}

// (f) a stale Claude registration in settings.json (target gone).
{
  const yDir = mktmp();
  runInstaller([`--claude`, `--dir=${yDir}`]);
  const settingsPath = path.join(yDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [
    { type: 'command', command: `node "${path.join(yDir, 'hooks', 'trailhead-gone-guard.js')}"` },
  ] });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const out = runPkg(repoRoot, [`--claude`, `--dir=${yDir}`]);
  ok('(f) stale Claude registration: non-zero exit', out.status !== 0);
  ok('(f) stale Claude registration: stderr names the stale target', out.stderr.includes('trailhead-gone-guard.js'));
}

// (g) a stale generic Codex registration in hooks.json (target gone).
{
  const wgDir = mktmp();
  runInstaller([`--codex`, `--dir=${wgDir}`]);
  const hooksJsonPath = path.join(wgDir, 'hooks.json');
  const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  hooksJson.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [
    { type: 'command', command: `node "${path.join(wgDir, 'skills', 'trailhead', 'hooks', 'trailhead-gone-guard.js')}"` },
  ] });
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2));
  const out = runPkg(repoRoot, [`--codex`, `--dir=${wgDir}`]);
  ok('(g) stale Codex registration: non-zero exit', out.status !== 0);
  ok('(g) stale Codex registration: stderr names the stale target', out.stderr.includes('trailhead-gone-guard.js'));
  ok('(g) stale Codex registration: stderr names hooks.json', out.stderr.includes('hooks.json'));
}

// (h) the pre-#169 search-guard registration migrates away silently on reinstall.
// May already pass before the installer wires verifyInstall in (no check exists
// yet to trip on it); it stays here to pin the migration's intent regardless.
{
  const zDir = mktmp();
  runInstaller([`--codex`, `--dir=${zDir}`]);
  const hooksJsonPath = path.join(zDir, 'hooks.json');
  const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  hooksJson.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [
    { type: 'command', command: `node "${path.join(zDir, 'skills', 'trailhead', 'hooks', 'trailhead-search-guard.js')}"` },
  ] });
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2));
  const out = runPkg(repoRoot, [`--codex`, `--dir=${zDir}`]);
  ok('(h) pre-#169 search-guard migration: exit 0', out.status === 0);
  ok('(h) pre-#169 search-guard migration: prints ✓', out.stdout.includes('✓'));
  const afterHooksJson = fs.readFileSync(hooksJsonPath, 'utf8');
  ok('(h) pre-#169 search-guard migration: the stale entry is gone', !afterHooksJson.includes('trailhead-search-guard.js'));
}

// (i) an unresolved env var on a registered target warns instead of failing.
{
  const vDir = mktmp();
  runInstaller([`--claude`, `--dir=${vDir}`]);
  const settingsPath = path.join(vDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [
    { type: 'command', command: 'node "${TRAILHEAD_T182_UNSET}/hooks/trailhead-x-guard.js"' },
  ] });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  // Delete the key outright (never set it to undefined), so the child process
  // never receives a literal "undefined" string for it.
  const envWithoutVar = { ...process.env };
  delete envWithoutVar.TRAILHEAD_T182_UNSET;
  const out = runPkg(repoRoot, [`--claude`, `--dir=${vDir}`], envWithoutVar);
  ok('(i) unresolved env var: exit 0', out.status === 0);
  ok('(i) unresolved env var: prints ✓', out.stdout.includes('✓'));
  ok('(i) unresolved env var: stdout warns ⚠ unverified', out.stdout.includes('⚠ unverified'));
  ok('(i) unresolved env var: stdout names the unresolved variable', out.stdout.includes('TRAILHEAD_T182_UNSET'));
}

// (j) regression: the existing clean installs at the top of this file still
// print ✓ with no ⚠ unverified.
ok('(j) claude clean install: prints ✓ trailhead installed', claudeInstallOut.includes('✓ trailhead installed'));
ok('(j) claude clean install: no ⚠ unverified', !claudeInstallOut.includes('⚠ unverified'));
ok('(j) codex clean install: prints ✓ trailhead installed', codexInstallOut.includes('✓ trailhead installed'));
ok('(j) codex clean install: no ⚠ unverified', !codexInstallOut.includes('⚠ unverified'));

// --- #183: severity counts and per-finding disposition gate on Resolve -------
// Code review classifies findings as Critical/Warning/Info, but only Criticals
// gated resolution and Warnings/Info were never tracked to a decision. Pin the
// counts line under `status:`, the disposition vocabulary, and the Resolve gate
// that requires every counted finding to carry one before a ticket can close.
const codeReviewSourcePath183 = path.join(sourceSkillsDir, '_shared', 'techniques', 'code-review.md');
const codeReviewSource183 = fs.readFileSync(codeReviewSourcePath183, 'utf8');
const ticketEnginesSource183 = fs.readFileSync(path.join(sourceSkillsDir, 'trailhead-work', 'references', 'ticket-engines.md'), 'utf8');

ok('code-review.md states the counts format right under the status tag',
  codeReviewSource183.includes('critical: <n> · warning: <n> · info: <n>'));
ok('code-review.md says the counts line sits right under the status tag',
  /right under[^.]*`status:`/.test(codeReviewSource183) || /`status:`[^.]*right under/.test(codeReviewSource183));

ok('code-review.md names the fixed disposition', codeReviewSource183.includes('`fixed`'));
ok('code-review.md names the deferred disposition', codeReviewSource183.includes('`deferred → <ticket>`'));
ok('code-review.md names the accepted disposition', codeReviewSource183.includes('`accepted: <one-line reason>`'));
ok('code-review.md names the transient open disposition', codeReviewSource183.includes('`open`'));

ok('code-review.md says finding IDs are stable across rounds',
  /stable/i.test(codeReviewSource183) && /across (every|fix-and-re-review) round/i.test(codeReviewSource183));
ok('code-review.md says the counts are cumulative', codeReviewSource183.includes('cumulative'));
ok('code-review.md says no finding reaches Resolve with open or without a disposition',
  /no finding reaches Resolve with[^.]*`open`[^.]*without a disposition/.test(codeReviewSource183));

ok('code-review.md no longer defers Warnings/Info as "noted for the caller to weigh"',
  !codeReviewSource183.includes('noted for the caller to weigh'));

const verifyStepLines183 = ticketEnginesSource183.split('\n').filter((l) => l.trim().startsWith('4. **Verify**'));
ok('ticket-engines.md has exactly two Verify (step 4) lines', verifyStepLines183.length === 2);
ok('both Verify step lines mention the counts line',
  verifyStepLines183.every((l) => l.includes('counts line')));

const resolveStepLines183 = ticketEnginesSource183.split('\n').filter((l) => l.trim().startsWith('5. **Resolve**'));
ok('ticket-engines.md has exactly two Resolve (step 5) lines', resolveStepLines183.length === 2);
ok('both Resolve step lines carry the Disposition gate',
  resolveStepLines183.every((l) => l.includes('**Disposition gate (before the close)**')));

for (const [label, src] of [
  ['code-review.md', codeReviewSource183],
  ['ticket-engines.md', ticketEnginesSource183],
]) {
  ok(`${label} has no em-dash (#183)`, !src.includes('\u2014'));
}

// --- plan-review: "run until it converges" option at the rounds-exhausted ask ---
const planReviewSourceConv = fs.readFileSync(path.join(sourceSkillsDir, '_shared', 'techniques', 'plan-review.md'), 'utf8');
const planReviewStep4 = planReviewSourceConv.split('\n').find((l) => l.startsWith('4. **Record and decide.**')) || '';
ok('plan-review.md step 4 still offers another bounded review cycle', planReviewStep4.includes('run another review cycle'));
ok('plan-review.md step 4 offers running until the plan converges', /\(d\) \*\*run until it converges\*\*/.test(planReviewStep4));
ok('plan-review.md converge option stops when no blocking concern remains', /run until it converges[\s\S]{0,400}no blocking concern remains/.test(planReviewStep4));
ok('plan-review.md converge option has a no-progress guard that returns to this checkpoint',
  /run until it converges[\s\S]{0,600}no progress[\s\S]{0,300}back to this checkpoint/.test(planReviewStep4));
ok('plan-review.md step 4 has no em-dash', !planReviewStep4.includes('\u2014'));

// --- cleanup -------------------------------------------------------------------
for (const d of tmpDirs) {
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`✓ trailhead.js (installer): ${passed} assertions passed`);
