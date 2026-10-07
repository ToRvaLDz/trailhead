#!/usr/bin/env node
'use strict';
// trailhead audit walk (self-contained, ships in templates/ so it reaches every
// install channel, like trailhead-commit-msg-sync.js). Runs the deterministic
// parts of `/trailhead:audit`: the fast path (references/auditing.md step 4)
// and the attribution walk (step 6). The prose in auditing.md stays the spec;
// this script implements it. #193.
//
// CLI (JSON on stdout, exit 0; usage or fatal errors exit 2 with {"error":...}):
//   index     --repo <dir>
//   fastpath  --repo <dir> [--index <file>] <n> [<n>...]
//   attribute --repo <dir> [--index <file>] --ticket <n> --claim <spec> [--claim <spec>...]
// A claim spec is a comma list of `<path>:<s>-<e>` (HEAD line range) or
// `<path>:@<g>` (deletion gap after HEAD line g). `index` prints the trailer
// index; save it and pass it back with --index so a whole audit scans once.
//
// Git is only ever run through execFileSync('git', ['-C', repo, ...]), never a
// shell, with LC_ALL=C so output parsing is stable on localized machines.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Tokens `#<digits>` delimited by start/end, comma or whitespace, so `#19`
// never matches inside `#192`. Input is the value of a parsed `Refs:` trailer.
function parseRefs(value) {
  const found = [];
  const re = /(?:^|[,\s])#(\d+)(?=$|[,\s])/g;
  const text = String(value == null ? '' : value);
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

// `@@ -a,k +b,l @@` headers of a unified diff, in order. A missing count is 1.
// Only lines that START with `@@ ` are headers: diff content lines always begin
// with ` `, `+` or `-`, so a content line can never be mistaken for one.
function parseHunks(diffText) {
  const hunks = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of String(diffText).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldLen: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLen: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

// The shared touching rule (auditing.md step 4). `tracked` is a set of old-side
// line numbers, `anchors` a set of deletion gaps (gap g = after old line g).
// A hunk touches when its old range overlaps a tracked line or covers line g or
// g+1 of an anchor; a pure insertion `-b,0` touches when b or b+1 is tracked or
// an anchor sits at gap b.
function hunkTouches(hunk, tracked, anchors) {
  const lines = tracked instanceof Set ? tracked : new Set(tracked || []);
  const gaps = anchors instanceof Set ? anchors : new Set(anchors || []);
  if (hunk.oldLen === 0) {
    const b = hunk.oldStart;
    return lines.has(b) || lines.has(b + 1) || gaps.has(b);
  }
  const start = hunk.oldStart;
  const end = hunk.oldStart + hunk.oldLen - 1;
  for (const line of lines) if (line >= start && line <= end) return true;
  for (const g of gaps) if ((g >= start && g <= end) || (g + 1 >= start && g + 1 <= end)) return true;
  return false;
}

// --- git plumbing ----------------------------------------------------------------
// LC_ALL=C: stable (non-localized) output. Literal pathspecs: a ticket file name
// is never interpreted as a pathspec pattern.
const GIT_ENV = { ...process.env, LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1' };

function git(repo, args) {
  return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8', env: GIT_ENV, input: '', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30,
  });
}

// Exit status of a git call whose status is the answer (0/1); anything that is
// not a clean exit (git missing, fatal) still throws.
function gitStatus(repo, args) {
  try {
    git(repo, args);
    return 0;
  } catch (err) {
    if (err && typeof err.status === 'number') return err.status;
    throw err;
  }
}

// `git diff --quiet`-style calls: true when git reports a difference (exit 1),
// false when it reports none (exit 0), an error for anything else (exit 128).
function gitDiffers(repo, args) {
  const status = gitStatus(repo, args);
  if (status > 1) throw new Error(`git diff failed (${status})`);
  return status === 1;
}

// Per-call context: the repo plus caches, so repeated ancestry and diff reads
// during one audit cost one git call each.
function makeCtx(repo) {
  return { repo, ancestors: new Map(), nameStatus: new Map(), emptyTree: null };
}

// A rev that is not a full object id never reaches git as an argument, where it
// could be read as an option.
function assertSha(rev) {
  if (!SHA_RE.test(rev)) throw new Error(`not a full object id: ${rev}`);
  return rev;
}

function isAncestor(ctx, a, b) {
  assertSha(a);
  assertSha(b);
  if (a === b) return true;
  const key = `${a}>${b}`;
  if (!ctx.ancestors.has(key)) {
    const status = gitStatus(ctx.repo, ['merge-base', '--is-ancestor', a, b]);
    if (status > 1) throw new Error(`git merge-base failed (${status})`);
    ctx.ancestors.set(key, status === 0);
  }
  return ctx.ancestors.get(key);
}

function emptyTree(ctx) {
  if (!ctx.emptyTree) ctx.emptyTree = git(ctx.repo, ['hash-object', '-t', 'tree', '--stdin']).trim();
  return ctx.emptyTree;
}

function objectExists(ctx, spec) {
  return gitStatus(ctx.repo, ['cat-file', '-e', spec]) === 0;
}

// `-z` name-status output -> [{ status, oldPath, newPath }]. Renames and copies
// carry two paths, every other status one (oldPath === newPath).
function parseNameStatusZ(output) {
  const tokens = String(output).split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i].replace(/^\n+/, '');
    if (!status) { i++; continue; }
    if (/^[RC]/.test(status)) {
      entries.push({ status: status[0], oldPath: tokens[i + 1], newPath: tokens[i + 2] });
      i += 3;
    } else {
      entries.push({ status: status[0], oldPath: tokens[i + 1], newPath: tokens[i + 1] });
      i += 2;
    }
  }
  return entries;
}

// `git diff -M --name-status p c`, no pathspec, so a rename is seen with both names.
function readNameStatus(ctx, p, c) {
  const key = `${p}..${c}`;
  if (!ctx.nameStatus.has(key)) {
    ctx.nameStatus.set(key, parseNameStatusZ(git(ctx.repo, ['diff', '-M', '--name-status', '-z', p, c])));
  }
  return ctx.nameStatus.get(key);
}

function readHunks(ctx, p, c, paths) {
  return parseHunks(git(ctx.repo, ['diff', '-M', '-U0', '--no-color', '--no-ext-diff', p, c, '--', ...paths]));
}

// Parents of c, in order ([] for a root commit).
function parentsOf(ctx, c) {
  return git(ctx.repo, ['rev-list', '--parents', '-n', '1', '--end-of-options', assertSha(c)]).trim().split(' ').slice(1);
}

// The one parent a ticket commit is diffed against: its first parent that
// descends from (or is) the previous ticket commit, else its first parent; a
// root commit diffs against the empty tree.
function chosenParent(ctx, c, from) {
  const parents = parentsOf(ctx, c);
  if (!parents.length) return emptyTree(ctx);
  if (from) {
    for (const p of parents) if (isAncestor(ctx, from, p)) return p;
  }
  return parents[0];
}

// The single chain from `to` back to `from`: at each step the first parent that
// descends from `from`. Returns [{ p, c }] oldest first, `from` itself excluded.
function chainBetween(ctx, from, to) {
  const chain = [];
  for (let cur = to; cur !== from;) {
    const p = parentsOf(ctx, cur).find((parent) => isAncestor(ctx, from, parent));
    if (!p) throw new Error(`no chain from ${from} to ${to}`);
    chain.push({ p, c: cur });
    cur = p;
  }
  return chain.reverse();
}

// --- trailer index -----------------------------------------------------------------
// One `git log` pass over HEAD: every commit's parsed `Refs:` trailer (never
// prose), indexed by ticket number. Shape: { head, shallow, byTicket, refsBySha }.
function buildTrailerIndex(repo) {
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  const shallow = git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  const out = git(repo, ['log', '--format=%H%x00%(trailers:key=Refs,valueonly,separator=%x2C)%x1e', 'HEAD']);
  const byTicket = {};
  const refsBySha = {};
  for (const record of out.split('\x1e')) {
    const text = record.replace(/^\n+/, '');
    if (!text) continue;
    const [sha, value] = text.split('\0');
    const refs = parseRefs(value);
    if (!refs.length) continue;
    refsBySha[sha] = refs;
    for (const n of refs) (byTicket[n] = byTicket[n] || []).push(sha);
  }
  return { head, shallow, byTicket, refsBySha };
}

// Full object ids (sha-1 or sha-256), the only form allowed into git's argv.
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// A saved index is only ever used when it is well formed and was taken at the
// repo's current HEAD; otherwise it is rejected, never silently trusted.
function validateIndex(repo, index) {
  const shapeOk = index && typeof index === 'object' && typeof index.head === 'string'
    && typeof index.shallow === 'boolean'
    && index.byTicket && typeof index.byTicket === 'object'
    && index.refsBySha && typeof index.refsBySha === 'object';
  if (!shapeOk) throw new Error('malformed index: expected {head, shallow, byTicket, refsBySha}');
  // Everything in the index ends up in git's argv, so it must look exactly like
  // what buildTrailerIndex writes: full hex shas and decimal ticket numbers.
  const numbers = (list) => Array.isArray(list) && list.every((n) => Number.isInteger(n) && n >= 0);
  const wellFormed = SHA_RE.test(index.head)
    && Object.entries(index.byTicket).every(([n, list]) => /^\d+$/.test(n)
      && Array.isArray(list) && list.every((sha) => typeof sha === 'string' && SHA_RE.test(sha)))
    && Object.entries(index.refsBySha).every(([sha, refs]) => SHA_RE.test(sha) && numbers(refs));
  if (!wellFormed) throw new Error('malformed index: shas must be full hex and ticket numbers decimal');
  const current = git(repo, ['rev-parse', 'HEAD']).trim();
  if (index.head !== current) {
    throw new Error(`stale index: taken at ${index.head}, HEAD is ${current}; rebuild it with the index command`);
  }
  return index;
}

function resolveIndex(repo, index) {
  return index === undefined || index === null ? buildTrailerIndex(repo) : validateIndex(repo, index);
}

// --- line mapping -------------------------------------------------------------------
// A hunk lies wholly before position x (a line, or a gap after line x) when its
// old range ends before x; a pure insertion `-b,0` when b < x.
function hunkBefore(hunk, x) {
  return hunk.oldLen > 0 ? hunk.oldStart + hunk.oldLen - 1 < x : hunk.oldStart < x;
}

// Shift of an untouched line or gap: the summed delta of the hunks wholly before it.
function shiftBy(hunks, x) {
  let delta = 0;
  for (const hunk of hunks) if (hunkBefore(hunk, x)) delta += hunk.newLen - hunk.oldLen;
  return delta;
}

// --- baseline (auditing.md step 4: commits, order, files, tracked lines, anchors) ----
// Orders the ticket's commits purely by ancestry. Each commit's rank is the
// number of other ticket commits below it; the set is a total order exactly when
// the ranks are 0..k-1, otherwise it is non-linear (null).
function orderByAncestry(ctx, commits) {
  const ranked = commits.map((c) => ({
    c, rank: commits.filter((o) => o !== c && isAncestor(ctx, o, c)).length,
  }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.every((entry, i) => entry.rank === i) ? ranked.map((entry) => entry.c) : null;
}

// Lines `git blame` attributes to a ticket commit at `last`.
function trackedLinesAt(ctx, last, file, ticketSet) {
  const tracked = new Map();
  for (const line of git(ctx.repo, ['blame', '--porcelain', last, '--', file]).split('\n')) {
    const m = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(line);
    if (m && ticketSet.has(m[1])) tracked.set(Number(m[2]), []);
  }
  return tracked;
}

// Moves a deletion anchor from ticket commit `from` (gap in that commit's
// post-image of `startPath`) to `last`, replaying the chain. A later ticket
// commit's touching hunk is part of the ticket (the anchor is carried to the
// hunk's new-side end gap); a non-ticket touching hunk gives { guard: true }; a
// deleted file gives null. Renames are followed.
function replayAnchor(ctx, from, last, startPath, startGap, ticketSet) {
  let filePath = startPath;
  let gap = startGap;
  for (const { p, c } of chainBetween(ctx, from, last)) {
    const entry = readNameStatus(ctx, p, c).find((e) => e.oldPath === filePath);
    if (!entry) continue;
    if (entry.status === 'D') return null;
    const paths = entry.status === 'R' ? [entry.oldPath, entry.newPath] : [filePath];
    const hunks = readHunks(ctx, p, c, paths);
    const hit = hunks.find((h) => hunkTouches(h, [], [gap]));
    if (hit) {
      if (!ticketSet.has(c)) return { guard: true };
      gap = hit.newLen > 0 ? hit.newStart + hit.newLen - 1 : hit.newStart;
    } else {
      gap += shiftBy(hunks, gap);
    }
    filePath = entry.newPath;
  }
  return { path: filePath, gap };
}

// Everything the fast path and the walk share about one ticket. `result` is
// either { reason } (no baseline: no-refs, shallow, non-linear, guard) or the
// baseline itself: { commits, last, files, states, deleted }.
//   states: Map<path at last, { tracked: Map<line, []>, anchors: Map<gap, []> }>
//   deleted: ticket files absent at <last> (ticket-deleted, or renamed away)
function ticketBaseline(ctx, n, index, { guard }) {
  const commits = index.byTicket[String(n)] || [];
  if (!commits.length) return { reason: 'no-refs', commits: [] };
  if (index.shallow) return { reason: 'shallow', commits };
  const order = orderByAncestry(ctx, commits);
  if (!order) return { reason: 'non-linear', commits };
  const last = order[order.length - 1];
  const ticketSet = new Set(order);

  const parents = order.map((c, i) => chosenParent(ctx, c, order[i - 1]));
  const fileSet = new Set();
  order.forEach((c, i) => {
    for (const f of git(ctx.repo, ['diff', '--name-only', '-z', parents[i], c]).split('\0')) if (f) fileSet.add(f);
  });
  let files = [...fileSet].sort();
  const known = { commits: order, last, files };

  // Guard: a non-ticket commit on the chain that touches a ticket file leaves
  // no trustworthy baseline (a side branch surfaces through its merge commit).
  // The anchor check below still runs after a hit, so eligibility is computed
  // the same way whether or not the chain guard fired.
  let chainGuard = false;
  // No files, nothing to guard: an empty pathspec would diff the whole tree.
  if (guard && files.length) {
    for (const { p, c } of chainBetween(ctx, order[0], last)) {
      if (!ticketSet.has(c) && gitStatus(ctx.repo, ['diff', '--quiet', p, c, '--', ...files]) === 1) {
        chainGuard = true;
        break;
      }
    }
  }

  const states = new Map();
  const deleted = [];
  for (const file of files) {
    if (objectExists(ctx, `${last}:${file}`)) {
      states.set(file, { tracked: trackedLinesAt(ctx, last, file, ticketSet), anchors: new Map() });
    } else {
      deleted.push(file);
    }
  }

  // Anchors: every pure-deletion hunk of a ticket commit, moved to <last>.
  for (let i = 0; i < order.length; i++) {
    for (const entry of readNameStatus(ctx, parents[i], order[i])) {
      if (entry.status === 'D') continue;
      const paths = entry.oldPath === entry.newPath ? [entry.newPath] : [entry.oldPath, entry.newPath];
      for (const hunk of readHunks(ctx, parents[i], order[i], paths)) {
        if (hunk.newLen !== 0 || hunk.oldLen === 0) continue;
        const moved = replayAnchor(ctx, order[i], last, entry.newPath, hunk.newStart, ticketSet);
        if (moved && moved.guard) return { ...known, reason: 'guard', anchorGuard: true };
        if (!moved || !states.has(moved.path)) {
          if (moved && objectExists(ctx, `${last}:${moved.path}`)) {
            states.set(moved.path, { tracked: new Map(), anchors: new Map() });
            files = [...files, moved.path].sort();
          } else {
            continue;
          }
        }
        states.get(moved.path).anchors.set(moved.gap, []);
      }
    }
  }
  if (chainGuard) return { ...known, files, reason: 'guard', anchorGuard: false };
  return { ...known, files, states, deleted };
}

// --- fast path (auditing.md step 4) --------------------------------------------------
function dirtyFilesOf(ctx, files) {
  if (!files.length) return [];
  const tokens = git(ctx.repo, ['status', '--porcelain', '-z', '-uall', '--', ...files]).split('\0');
  const dirty = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    dirty.push(t.slice(3));
    if (/[RC]/.test(t.slice(0, 2))) i++; // a rename entry is followed by its source path
  }
  return dirty.sort();
}

// The decision (step 4 "Decide") of last..HEAD over the ticket's files.
function decideChange(ctx, base) {
  for (const file of base.deleted) {
    if (objectExists(ctx, `HEAD:${file}`)) return 'recreated';
  }
  const existing = [...base.states.keys()];
  if (existing.length) {
    const gone = parseNameStatusZ(git(ctx.repo, ['diff', '-M', '--name-status', '-z', base.last, 'HEAD', '--', ...existing]));
    if (gone.some((e) => e.status === 'D' || e.status === 'R')) return 'deleted-or-renamed';
  }
  for (const [file, state] of base.states) {
    if (gitStatus(ctx.repo, ['diff', '--quiet', base.last, 'HEAD', '--', file]) !== 1) continue;
    if (git(ctx.repo, ['cat-file', '-s', `${base.last}:${file}`]).trim() === '0') return 'touching-hunk';
    const hunks = parseHunks(git(ctx.repo, ['diff', '-U0', '--no-color', '--no-ext-diff', base.last, 'HEAD', '--', file]));
    if (!hunks.length) return 'non-textual';
    const lines = new Set(state.tracked.keys());
    const gaps = new Set(state.anchors.keys());
    if (hunks.some((h) => hunkTouches(h, lines, gaps))) return 'touching-hunk';
  }
  return null;
}

// Fast path for one ticket: { ticket, class, reason, evolvedEligible, last,
// commits, files, dirtyFiles }. `index` is optional (built when absent); a saved
// one that is stale or malformed throws.
function fastPath(repo, n, index) {
  const idx = resolveIndex(repo, index);
  const ctx = makeCtx(repo);
  const out = {
    ticket: n, class: 'changed', reason: null, evolvedEligible: false,
    last: null, commits: [], files: [], dirtyFiles: [],
  };
  try {
    const base = ticketBaseline(ctx, n, idx, { guard: true });
    if (base.reason && !base.last) return { ...out, reason: base.reason, commits: base.reason === 'shallow' ? base.commits : [] };
    const known = { last: base.last, commits: base.commits, files: base.files };
    // Evolved stays possible after a chain guard (the walk starts at <last>) but
    // not when an anchor could not be replayed.
    if (base.reason) return { ...out, ...known, reason: base.reason, evolvedEligible: !base.anchorGuard };
    const reason = decideChange(ctx, base);
    return {
      ...out, ...known, class: reason ? 'changed' : 'unchanged', reason, evolvedEligible: true,
      dirtyFiles: dirtyFilesOf(ctx, base.files),
    };
  } catch (err) {
    return { ...out, reason: 'git-error' };
  }
}

// --- attribution walk (auditing.md step 6) ---------------------------------------------
// Claim spec -> [{ path, start, end } | { path, gap }]. A comma list unions its
// parts (so a path containing a comma cannot be claimed).
function parseClaim(spec) {
  return String(spec).split(',').map((part) => {
    const m = /^(.+):(?:@(\d+)|(\d+)-(\d+))$/.exec(part);
    if (!m) throw new Error(`invalid claim spec: ${part} (expected <path>:<s>-<e> or <path>:@<g>)`);
    return m[2] !== undefined
      ? { path: m[1], gap: Number(m[2]) }
      : { path: m[1], start: Number(m[3]), end: Number(m[4]) };
  });
}

function union(...lists) {
  return [...new Set(lists.flat())];
}

// Producers of a merge commit's hunk, in c's coordinates: the commits `git log
// -L` lists over p..c (intermediate overwritten ones included, plus c itself
// when the merge resolved a conflict on those lines). Trusted only on a simple
// side history, checked without any pathspec: no nested merge in p..c, no rename
// of the file on either side. Anything else, or a failure, or an empty result,
// returns c itself (conservative).
function mergeProducers(ctx, p, c, entryPaths, hunk) {
  try {
    const range = `${p}..${c}`;
    const merges = git(ctx.repo, ['rev-list', '--merges', range]).split('\n').filter(Boolean);
    if (merges.some((m) => m !== c)) return [c];
    const renamed = parseNameStatusZ(git(ctx.repo, ['log', '-M', '--name-status', '-z', '--format=', range]))
      .some((e) => e.status === 'R' && (entryPaths.includes(e.oldPath) || entryPaths.includes(e.newPath)));
    if (renamed) return [c];
    const newPath = entryPaths[entryPaths.length - 1];
    const out = git(ctx.repo, [
      'log', '--no-patch', '--format=%H', `-L${hunk.newStart},${hunk.newStart + hunk.newLen - 1}:${newPath}`, range,
    ]);
    const listed = out.split('\n').filter((line) => /^[0-9a-f]{40,64}$/.test(line));
    return listed.length ? listed : [c];
  } catch (err) {
    return [c];
  }
}

// Applies one commit's hunks to a file state. A touching hunk makes its
// producers part of the lineage: new-side lines become tracked and inherit the
// lineage of the tracked lines and anchors they replace (or sit next to) plus
// the producers; a pure deletion leaves an anchor at the new-side gap with the
// same lineage. Everything else shifts by the summed delta of the hunks before.
function applyHunks(state, hunks, producersFor) {
  const lines = new Set(state.tracked.keys());
  const gaps = new Set(state.anchors.keys());
  const consumedLines = new Set();
  const consumedGaps = new Set();
  const additions = [];
  for (const hunk of hunks) {
    if (!hunkTouches(hunk, lines, gaps)) continue;
    const inherited = [];
    if (hunk.oldLen === 0) {
      const b = hunk.oldStart;
      for (const l of [b, b + 1]) if (state.tracked.has(l)) inherited.push(state.tracked.get(l));
      if (state.anchors.has(b)) { inherited.push(state.anchors.get(b)); consumedGaps.add(b); }
    } else {
      const end = hunk.oldStart + hunk.oldLen - 1;
      for (const [l, lineage] of state.tracked) {
        if (l >= hunk.oldStart && l <= end) { inherited.push(lineage); consumedLines.add(l); }
      }
      for (const [g, lineage] of state.anchors) {
        if (g >= hunk.oldStart - 1 && g <= end) { inherited.push(lineage); consumedGaps.add(g); }
      }
    }
    const lineage = union(...inherited, producersFor(hunk));
    if (hunk.newLen > 0) {
      for (let i = 0; i < hunk.newLen; i++) additions.push({ line: hunk.newStart + i, lineage });
    } else {
      additions.push({ gap: hunk.newStart, lineage });
    }
  }
  const tracked = new Map();
  const anchors = new Map();
  for (const [l, lineage] of state.tracked) {
    if (!consumedLines.has(l)) tracked.set(l + shiftBy(hunks, l), lineage);
  }
  for (const [g, lineage] of state.anchors) {
    if (!consumedGaps.has(g)) anchors.set(g + shiftBy(hunks, g), lineage);
  }
  for (const add of additions) {
    const target = add.line === undefined ? anchors : tracked;
    const key = add.line === undefined ? add.gap : add.line;
    target.set(key, union(target.get(key) || [], add.lineage));
  }
  return { ...state, tracked, anchors };
}

// Walks every ticket file from <last> to HEAD along the single chain, keeping
// each file's current path (renames re-key the state). Returns Map<HEAD path, state>.
function walkToHead(ctx, base, head) {
  let states = new Map([...base.states].map(([file, s]) => [file, { ...s, deleted: false, lineage: [] }]));
  for (const { p, c } of chainBetween(ctx, base.last, head)) {
    const byOld = new Map(readNameStatus(ctx, p, c).map((e) => [e.oldPath, e]));
    const isMerge = parentsOf(ctx, c).length > 1;
    const next = new Map();
    for (const [file, state] of states) {
      const entry = byOld.get(file);
      if (state.deleted || !entry) { next.set(file, state); continue; }
      if (entry.status === 'D') {
        const every = union(...state.tracked.values(), ...state.anchors.values());
        next.set(file, { tracked: new Map(), anchors: new Map(), deleted: true, lineage: union(every, [c]) });
        continue;
      }
      if (entry.status !== 'M' && entry.status !== 'T' && entry.status !== 'R') { next.set(file, state); continue; }
      const entryPaths = entry.status === 'R' ? [entry.oldPath, entry.newPath] : [file];
      const hunks = readHunks(ctx, p, c, entryPaths);
      const producersFor = (hunk) => (isMerge && hunk.newLen > 0 ? mergeProducers(ctx, p, c, entryPaths, hunk) : [c]);
      next.set(entry.newPath, hunks.length ? applyHunks(state, hunks, producersFor) : state);
    }
    states = next;
  }
  return states;
}

// Lineage of the tracked lines and anchors one claim part overlaps in HEAD.
function lineageOf(finalStates, part) {
  const state = finalStates.get(part.path);
  if (!state) return [];
  if (state.deleted) return state.lineage;
  const found = [];
  if (part.gap !== undefined) {
    if (state.anchors.has(part.gap)) found.push(state.anchors.get(part.gap));
    for (const l of [part.gap, part.gap + 1]) if (state.tracked.has(l)) found.push(state.tracked.get(l));
  } else {
    for (const [l, lineage] of state.tracked) if (l >= part.start && l <= part.end) found.push(lineage);
    for (const [g, lineage] of state.anchors) if (g >= part.start - 1 && g <= part.end) found.push(lineage);
  }
  return union(...found);
}

function emptyClaim(spec) {
  return { spec, attributed: false, evolvedBy: [], producers: [] };
}

// Attribution for one ticket. `claims` are spec strings. Returns { ticket,
// eligible, reason, claims: [{ spec, attributed, evolvedBy, producers }] }.
// Attributed when the claim's lineage holds a producer and every producer's
// parsed `Refs:` names some #m other than n.
function attribute(repo, n, claims, index) {
  const parsed = (claims || []).map((spec) => ({ spec, parts: parseClaim(spec) }));
  const idx = resolveIndex(repo, index);
  const ctx = makeCtx(repo);
  const ineligible = (reason) => ({ ticket: n, eligible: false, reason, claims: parsed.map((c) => emptyClaim(c.spec)) });
  try {
    const base = ticketBaseline(ctx, n, idx, { guard: false });
    if (base.reason) return ineligible(base.reason);
    const finalStates = walkToHead(ctx, base, idx.head);
    const results = parsed.map(({ spec, parts }) => {
      const shaList = union(...parts.map((part) => lineageOf(finalStates, part))).sort();
      const producers = shaList.map((sha) => ({ sha, refs: idx.refsBySha[sha] || [] }));
      const evolving = (p) => p.refs.filter((m) => m !== n);
      const attributed = producers.length > 0 && producers.every((p) => evolving(p).length > 0);
      const evolvedBy = attributed ? union(...producers.map(evolving)).sort((a, b) => a - b) : [];
      return { spec, attributed, evolvedBy, producers };
    });
    return { ticket: n, eligible: true, reason: null, claims: results };
  } catch (err) {
    return ineligible('git-error');
  }
}

// --- CLI ----------------------------------------------------------------------------------
class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['index', 'fastpath', 'attribute'].includes(command)) {
    throw new UsageError('usage: trailhead-audit-walk.js <index|fastpath|attribute> --repo <dir> ...');
  }
  const opts = { command, repo: null, index: null, ticket: null, claims: [], tickets: [] };
  const value = (flag, i) => {
    if (i >= rest.length) throw new UsageError(`usage: ${flag} requires a value`);
    return rest[i];
  };
  const number = (text, what) => {
    if (!/^\d+$/.test(text)) throw new UsageError(`usage: ${what} must be a ticket number, got: ${text}`);
    return Number(text);
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--repo') opts.repo = value(arg, ++i);
    else if (arg === '--index') opts.index = value(arg, ++i);
    else if (arg === '--ticket' && command === 'attribute') opts.ticket = number(value(arg, ++i), '--ticket');
    else if (arg === '--claim' && command === 'attribute') opts.claims.push(value(arg, ++i));
    else if (command === 'fastpath' && !arg.startsWith('--')) opts.tickets.push(number(arg, 'ticket'));
    else throw new UsageError(`usage: unknown argument: ${arg}`);
  }
  if (command === 'fastpath' && !opts.tickets.length) throw new UsageError('usage: fastpath needs at least one ticket number');
  if (command === 'attribute' && opts.ticket === null) throw new UsageError('usage: attribute needs --ticket <n>');
  if (command === 'attribute' && !opts.claims.length) throw new UsageError('usage: attribute needs at least one --claim <spec>');
  return opts;
}

function readIndexFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`malformed index file ${file}: ${err.message}`);
  }
}

function run(opts, repo) {
  if (opts.command === 'index') return buildTrailerIndex(repo);
  const index = opts.index ? readIndexFile(opts.index) : buildTrailerIndex(repo);
  if (opts.command === 'attribute') return attribute(repo, opts.ticket, opts.claims, index);
  return { shallow: index.shallow === true, tickets: opts.tickets.map((n) => fastPath(repo, n, index)) };
}

// Exit 0 with the result as one JSON document; exit 2 with {"error":...} on a
// usage error or any fatal failure (not a repo, stale or malformed index, bad claim).
function main(argv, { cwd, stdout } = {}) {
  const out = stdout || process.stdout;
  try {
    const opts = parseArgs(argv || []);
    const repo = path.resolve(cwd || process.cwd(), opts.repo || '.');
    out.write(JSON.stringify(run(opts, repo)) + '\n');
    return 0;
  } catch (err) {
    out.write(JSON.stringify({ error: err && err.message ? err.message : String(err) }) + '\n');
    return 2;
  }
}

module.exports = { gitDiffers, parseRefs, parseHunks, hunkTouches, buildTrailerIndex, fastPath, attribute, parseArgs, main };

if (require.main === module) {
  // exitCode, not process.exit(): a large index on a pipe must flush first.
  process.exitCode = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout });
}
