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

// Per-call context: the repo plus caches, so repeated ancestry and diff reads
// during one audit cost one git call each.
function makeCtx(repo) {
  return { repo, ancestors: new Map(), nameStatus: new Map(), emptyTree: null };
}

function isAncestor(ctx, a, b) {
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
  return git(ctx.repo, ['rev-list', '--parents', '-n', '1', c]).trim().split(' ').slice(1);
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

// A saved index is only ever used when it is well formed and was taken at the
// repo's current HEAD; otherwise it is rejected, never silently trusted.
function validateIndex(repo, index) {
  const shapeOk = index && typeof index === 'object' && typeof index.head === 'string'
    && typeof index.shallow === 'boolean'
    && index.byTicket && typeof index.byTicket === 'object'
    && index.refsBySha && typeof index.refsBySha === 'object';
  if (!shapeOk) throw new Error('malformed index: expected {head, shallow, byTicket, refsBySha}');
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
  if (guard) {
    for (const { p, c } of chainBetween(ctx, order[0], last)) {
      if (!ticketSet.has(c) && gitStatus(ctx.repo, ['diff', '--quiet', p, c, '--', ...files]) === 1) {
        return { ...known, reason: 'guard', anchorGuard: false };
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

module.exports = { parseRefs, parseHunks, hunkTouches, buildTrailerIndex, fastPath };
