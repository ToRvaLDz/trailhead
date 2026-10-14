#!/usr/bin/env node
'use strict';
// trailhead isolation copy (self-contained, ships in templates/ so it reaches every
// install channel: bin/trailhead.js copies templates/ wholesale for Claude/npm
// and Codex). Copies the gitignored files an app needs to run (env files, local
// config) from the main checkout into a fresh worktree or clone. #242.
//
// CLI:
//   node trailhead-isolation-copy.js --from <main-checkout> --to <workspace>
// The list lives in `isolation.copy` of .trailhead/config.json: an array of
// repo-relative paths (file or directory, no globs), nested ({"isolation":
// {"copy":[...]}}) or flat ({"isolation.copy":[...]}); nested wins when a file
// carries both (a warning says so). The project file wins over the global one
// (${CLAUDE_CONFIG_DIR:-~/.claude}/trailhead/config.json) as a whole value: the
// global list applies only when the project file has no isolation.copy at all.
// Rules: a destination that already exists is never overwritten (reported
// `present`); absolute paths, `..`, any `.git` segment, and paths whose parent
// directory resolves outside its root (checked on both sides) are `rejected`;
// a final symlink is copied as a symlink, never followed; nested `.git` entries
// are skipped inside copied directories. An invalid config (bad JSON, non-array,
// non-string or empty entry) copies nothing and offers no hint.
// When the key is unset, tracked `*.example` / `*.sample` files whose stripped
// sibling exists in the main checkout and is gitignored are listed in
// `suggestions` (never copied).
// Prints one JSON line:
//   {"status","copied":[],"present":[],"missing":[],"rejected":[],"suggestions":[],"warnings":[],"message"?}
//   status: copied | nothing | unset | invalid | skipped
// Exit 0 on every normal outcome and on any unexpected I/O error (it must never
// block the caller: status skipped with the message); exit 2 only on a usage
// error (missing --from/--to, unknown flag).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG_REL = path.join('.trailhead', 'config.json');
const SUFFIXES = ['.example', '.sample'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' || a === '--to') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `usage: ${a} needs a value` };
      out[a.slice(2)] = v;
    } else {
      return { error: `usage: unknown argument ${a}` };
    }
  }
  if (!out.from) return { error: 'usage: missing --from <main-checkout>' };
  if (!out.to) return { error: 'usage: missing --to <workspace>' };
  return out;
}

// Returns null when the repo-relative entry is acceptable, else the reason.
function checkRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return 'empty path';
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return 'absolute path';
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.every((s) => s === '.')) return 'empty path';
  if (segments.includes('..')) return 'parent segment';
  if (segments.includes('.git')) return '.git segment';
  return null;
}

// Reads the copy list out of one config file.
// { state: 'unset' } | { state: 'set', list, warnings } | { state: 'invalid', message }
function readCopyList(file, fs_) {
  let text;
  try {
    text = fs_.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'unset' };
    return { state: 'invalid', message: `cannot read ${file}: ${err && err.message ? err.message : err}` };
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { state: 'invalid', message: `${file} is not valid JSON` };
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { state: 'invalid', message: `${file} is not a JSON object` };
  }
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const nested = cfg.isolation !== null && typeof cfg.isolation === 'object' && !Array.isArray(cfg.isolation) && has(cfg.isolation, 'copy');
  const flat = has(cfg, 'isolation.copy');
  if (!nested && !flat) return { state: 'unset' };
  const warnings = [];
  if (nested && flat) warnings.push(`${file} sets isolation.copy in both nested and flat form; the nested form wins`);
  const value = nested ? cfg.isolation.copy : cfg['isolation.copy'];
  if (!Array.isArray(value)) return { state: 'invalid', message: `isolation.copy in ${file} must be an array of paths` };
  if (value.some((e) => typeof e !== 'string' || e.trim() === '')) {
    return { state: 'invalid', message: `isolation.copy in ${file} must hold only non-empty strings` };
  }
  return { state: 'set', list: value, warnings };
}

function globalConfigPath(env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'trailhead', 'config.json');
}

// realpath of the deepest existing ancestor of p (p itself included).
function deepestReal(p, fs_) {
  let cur = p;
  for (;;) {
    try {
      return fs_.realpathSync(cur);
    } catch (err) {
      const up = path.dirname(cur);
      if (up === cur) return cur;
      cur = up;
    }
  }
}

// True when the parent directory of root/rel resolves inside realRoot.
function parentInside(root, realRoot, rel, fs_) {
  const real = deepestReal(path.dirname(path.join(root, rel)), fs_);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

const exists = (p, fs_) => {
  try { fs_.lstatSync(p); return true; } catch (err) { return false; }
};

// Tracked *.example / *.sample files whose stripped sibling is present and ignored.
function suggest(from, fs_) {
  let tracked;
  try {
    tracked = execFileSync('git', ['-C', from, 'ls-files', '-z'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .toString().split('\0').filter(Boolean);
  } catch (err) {
    return [];
  }
  const out = [];
  for (const file of tracked) {
    const suffix = SUFFIXES.find((s) => file.endsWith(s) && file.length > s.length);
    if (!suffix) continue;
    const sibling = file.slice(0, -suffix.length);
    if (out.includes(sibling) || checkRelPath(sibling) !== null || !exists(path.join(from, sibling), fs_)) continue;
    try {
      execFileSync('git', ['-C', from, 'check-ignore', '-q', '--', sibling], { stdio: 'ignore' });
      out.push(sibling);
    } catch (err) {
      // not ignored (exit 1) or git error: not a suggestion
    }
  }
  return out;
}

function copyEntries(list, from, to, fs_) {
  const result = { copied: [], present: [], missing: [], rejected: [], warnings: [] };
  const realFrom = fs_.realpathSync(from);
  const realTo = fs_.realpathSync(to);
  for (const rel of list) {
    if (checkRelPath(rel) !== null || !parentInside(from, realFrom, rel, fs_)) {
      result.rejected.push(rel);
      continue;
    }
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    if (!exists(src, fs_)) { result.missing.push(rel); continue; }
    if (!parentInside(to, realTo, rel, fs_)) { result.rejected.push(rel); continue; }
    if (exists(dst, fs_)) { result.present.push(rel); continue; }
    try {
      fs_.mkdirSync(path.dirname(dst), { recursive: true });
      // Re-check after creating parents: nothing may have been redirected meanwhile.
      if (!parentInside(to, realTo, rel, fs_)) { result.rejected.push(rel); continue; }
      fs_.cpSync(src, dst, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
        filter: (s) => path.basename(s) !== '.git',
      });
      result.copied.push(rel);
    } catch (err) {
      result.warnings.push(`could not copy ${rel}: ${err && err.message ? err.message : err}`);
      // This run created the destination (it did not exist before): drop any
      // partial copy so the next run retries instead of reporting it present.
      try {
        fs_.rmSync(dst, { recursive: true, force: true });
      } catch (cleanupErr) {
        result.warnings.push(`could not clean up partial ${rel}: ${cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr}`);
      }
    }
  }
  return result;
}

function writeResult(out, fields) {
  const result = { status: 'skipped', copied: [], present: [], missing: [], rejected: [], suggestions: [], warnings: [], ...fields };
  out.write(JSON.stringify(result) + '\n');
}

function main(argv, { cwd, stdout, env, fs: fsMod } = {}) {
  const cwd_ = cwd || process.cwd();
  const out = stdout || process.stdout;
  const env_ = env || process.env;
  const fs_ = fsMod || fs;

  const parsed = parseArgs(argv || []);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n');
    return 2;
  }
  const from = path.resolve(cwd_, parsed.from);
  const to = path.resolve(cwd_, parsed.to);
  try {
    let cfg = readCopyList(path.join(from, CONFIG_REL), fs_);
    if (cfg.state === 'unset') cfg = readCopyList(globalConfigPath(env_), fs_);
    if (cfg.state === 'invalid') {
      writeResult(out, { status: 'invalid', message: cfg.message });
      return 0;
    }
    if (cfg.state === 'unset') {
      writeResult(out, { status: 'unset', suggestions: suggest(from, fs_) });
      return 0;
    }
    const res = copyEntries(cfg.list, from, to, fs_);
    res.warnings = [...cfg.warnings, ...res.warnings];
    writeResult(out, { ...res, status: res.copied.length > 0 ? 'copied' : 'nothing' });
    return 0;
  } catch (err) {
    writeResult(out, { status: 'skipped', message: 'error: ' + (err && err.message ? err.message : String(err)) });
    return 0;
  }
}

module.exports = { checkRelPath, readCopyList, parseArgs, main };

if (require.main === module) {
  const code = main(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, env: process.env });
  process.exit(code);
}
