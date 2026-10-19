#!/usr/bin/env node
// Tests for trailhead-secret-read-guard.js. Run: node trailhead-secret-read-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { detectSecretRead } = require('./trailhead-secret-read-guard.js');

const HOOK = path.join(__dirname, 'trailhead-secret-read-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Run the hook end-to-end: pipe {tool_name, tool_input} JSON on stdin, capture {code, out}.
function runHook(toolName, toolInput) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  try {
    const out = execFileSync('node', [HOOK], { input });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}

// --- pure seam: detectSecretRead ---

// --- DENY cases ---
ok('Read .env is denied', !!detectSecretRead('Read', { file_path: '.env' }));
ok('Read config/.env.local is denied', !!detectSecretRead('Read', { file_path: 'config/.env.local' }));
ok('Read .secrets is denied', !!detectSecretRead('Read', { file_path: '.secrets' }));
ok('Bash cat .env is denied', !!detectSecretRead('Bash', { command: 'cat .env' }));
ok('Bash cat < .secrets is denied', !!detectSecretRead('Bash', { command: 'cat < .secrets' }));
ok('Bash grep -n KEY .env.production is denied', !!detectSecretRead('Bash', { command: 'grep -n KEY .env.production' }));
ok('Bash cat app/.env.local is denied', !!detectSecretRead('Bash', { command: 'cat app/.env.local' }));
ok('Bash cat --file=.env is denied', !!detectSecretRead('Bash', { command: 'cat --file=.env' }));

// --- line continuation splits a secret path (#222) ---
ok('Bash cat \\<nl>.env is denied', !!detectSecretRead('Bash', { command: 'cat \\\n.env' }));
ok('Bash echo $(cat \\<nl>.env) is denied', !!detectSecretRead('Bash', { command: 'echo $(cat \\\n.env)' }));
ok('Bash cat .e\\<nl>nv is denied', !!detectSecretRead('Bash', { command: 'cat .e\\\nnv' }));
ok('Bash cat .e\\\\<nl>nv (escaped backslash) is allowed', !detectSecretRead('Bash', { command: 'cat .e\\\\\nnv' }));
ok('Bash continuation inside single quotes stays literal', !detectSecretRead('Bash', { command: "echo 'x\\\n.env'" }));
ok('Bash consecutive continuations cat \\<nl>\\<nl>.env are denied', !!detectSecretRead('Bash', { command: 'cat \\\n\\\n.env' }));
ok('Bash separator on the continuation line is denied', !!detectSecretRead('Bash', { command: 'echo a \\\n; cat .env' }));
ok('Bash continuation inside a backtick span is denied', !!detectSecretRead('Bash', { command: 'echo `cat \\\n.env`' }));
ok('Bash continuation inside "$(..)" is denied', !!detectSecretRead('Bash', { command: 'echo "$(cat .e\\\nnv)"' }));
ok('Bash trailing backslash on the last line is allowed', !detectSecretRead('Bash', { command: 'echo done \\' }));

// --- ALLOW cases (no false positives) ---
ok('Read src/app.ts is allowed', !detectSecretRead('Read', { file_path: 'src/app.ts' }));
ok('Bash grep -n x pubspec.yaml is allowed', !detectSecretRead('Bash', { command: 'grep -n x pubspec.yaml' }));
ok('Bash cat README.md is allowed', !detectSecretRead('Bash', { command: 'cat README.md' }));
ok('Bash cd app && grep x pubspec.yaml is allowed (not a secret; search-guard governs the cd shape)',
  !detectSecretRead('Bash', { command: 'cd app && grep x pubspec.yaml' }));
ok('Read env.sample (near-miss) is allowed', !detectSecretRead('Read', { file_path: 'env.sample' }));
ok('Read .environment (near-miss) is allowed', !detectSecretRead('Read', { file_path: '.environment' }));

// --- #135 follow-up: Finding 1 - glued shell metacharacters must not bypass detection ---
ok('Bash cat .env|grep KEY is denied (glued pipe)', !!detectSecretRead('Bash', { command: 'cat .env|grep KEY' }));
ok('Bash cat .env;echo done is denied (glued semicolon)', !!detectSecretRead('Bash', { command: 'cat .env;echo done' }));
ok('Bash cat .env after an arithmetic << on the previous line is denied (#212)',
  !!detectSecretRead('Bash', { command: 'echo $((1<<3))\ncat .env' }));
ok('Bash cat .env&&echo done is denied (glued &&)', !!detectSecretRead('Bash', { command: 'cat .env&&echo done' }));
ok('Bash bash -c "cat .env" is denied (quoted sub-command)', !!detectSecretRead('Bash', { command: 'bash -c "cat .env"' }));
ok('Bash eval "cat .env" is denied (quoted sub-command)', !!detectSecretRead('Bash', { command: 'eval "cat .env"' }));

// --- #135 follow-up: Finding 2 - glued short-option value must not bypass detection ---
ok('Bash cat -f.env is denied (glued short-flag value)', !!detectSecretRead('Bash', { command: 'cat -f.env' }));

// --- #135 follow-up: Finding 3 - bare .env inside quoted prose must not false-positive ---
ok('Bash git commit -m "document .env usage" is allowed (quoted prose, not a file operand)',
  !detectSecretRead('Bash', { command: 'git commit -m "document .env usage"' }));
ok('Bash echo "See .env for config" >> README.md is allowed (quoted prose)',
  !detectSecretRead('Bash', { command: 'echo "See .env for config" >> README.md' }));
ok('Bash cat ".env" is still denied (a quoted LONE path is still a secret path)',
  !!detectSecretRead('Bash', { command: 'cat ".env"' }));

// --- #135 follow-up: Finding 4 - quoted grep pattern must not false-positive ---
ok('Bash grep ".env" config.txt is allowed (the read target is config.txt, not the pattern)',
  !detectSecretRead('Bash', { command: 'grep ".env" config.txt' }));
ok("Bash grep '.env' config.txt is allowed (single-quoted pattern)",
  !detectSecretRead('Bash', { command: "grep '.env' config.txt" }));
ok('Bash grep -n KEY .env.production is still denied (secret is the FILE operand, not the pattern)',
  !!detectSecretRead('Bash', { command: 'grep -n KEY .env.production' }));

// --- #135 follow-up: Finding 5 - case-insensitivity (same file on macOS/Windows) ---
ok('Read .ENV is denied (case-insensitive)', !!detectSecretRead('Read', { file_path: '.ENV' }));
ok('Bash cat .SECRETS is denied (case-insensitive)', !!detectSecretRead('Bash', { command: 'cat .SECRETS' }));
ok('Read ENV.SAMPLE (near-miss) is still allowed regardless of case', !detectSecretRead('Read', { file_path: 'ENV.SAMPLE' }));
ok('Read .ENVIRONMENT (near-miss) is still allowed regardless of case', !detectSecretRead('Read', { file_path: '.ENVIRONMENT' }));

// --- #180: docker/podman --env-file must not be treated as a secret read ---
// The container runtime reads the file itself; its contents never reach the
// agent, so `--env-file .env` (or `=`-glued) is not a secret READ by the
// agent, unlike every other flag/positional in the same statement.
ok('Bash docker run --env-file .env img is allowed (runtime reads it, not the agent)',
  !detectSecretRead('Bash', { command: 'docker run --env-file .env img' }));
ok('Bash docker compose --env-file .env.prod up is allowed',
  !detectSecretRead('Bash', { command: 'docker compose --env-file .env.prod up' }));
ok('Bash podman run --env-file=.env img is allowed (glued = form)',
  !detectSecretRead('Bash', { command: 'podman run --env-file=.env img' }));
ok('Bash docker-compose --env-file .env up is allowed (standalone binary)',
  !detectSecretRead('Bash', { command: 'docker-compose --env-file .env up' }));
ok('Bash bash -c "docker run --env-file .env img" is allowed (recursion into nested command)',
  !detectSecretRead('Bash', { command: 'bash -c "docker run --env-file .env img"' }));

// --- #180: everything else in a docker/podman statement is still scanned ---
ok('Bash cat .env is still denied', !!detectSecretRead('Bash', { command: 'cat .env' }));
ok('Bash foo --env-file .env is still denied (only docker/podman are exempt)',
  !!detectSecretRead('Bash', { command: 'foo --env-file .env' }));
ok('Bash foo --env-file=.env is still denied (only docker/podman are exempt)',
  !!detectSecretRead('Bash', { command: 'foo --env-file=.env' }));
ok('Bash docker run --env-file .env img && cat .env is still denied (second statement)',
  !!detectSecretRead('Bash', { command: 'docker run --env-file .env img && cat .env' }));
ok('Bash docker run -v x img cat .env is still denied (positional after image, conservative)',
  !!detectSecretRead('Bash', { command: 'docker run -v x img cat .env' }));
ok('Bash docker cp .env ctr:/x is still denied (plain positional, not --env-file)',
  !!detectSecretRead('Bash', { command: 'docker cp .env ctr:/x' }));

// --- end-to-end hook wire format ---
const d1 = runHook('Read', { file_path: '.env' });
ok('hook denies Read(.env) end-to-end (exit 2, block decision)', d1.code === 2 && /"decision":"block"/.test(d1.out));

const d2 = runHook('Bash', { command: 'cat .env' });
ok('hook denies Bash(cat .env) end-to-end (exit 2, block decision)', d2.code === 2 && /"decision":"block"/.test(d2.out));

const a1 = runHook('Read', { file_path: 'src/app.ts' });
ok('hook allows Read(src/app.ts) end-to-end (exit 0, no output)', a1.code === 0 && a1.out.trim() === '');

const a2 = runHook('Bash', { command: 'cd app && grep x pubspec.yaml' });
ok('hook allows Bash(cd app && grep x pubspec.yaml) end-to-end (exit 0, no output)', a2.code === 0 && a2.out.trim() === '');

// --- #180 end-to-end ---
const a3 = runHook('Bash', { command: 'docker run --env-file .env img' });
ok('hook allows Bash(docker run --env-file .env img) end-to-end (exit 0, no output)', a3.code === 0 && a3.out.trim() === '');

const a4 = runHook('Bash', { command: 'docker compose --env-file .env.prod up' });
ok('hook allows Bash(docker compose --env-file .env.prod up) end-to-end (exit 0, no output)', a4.code === 0 && a4.out.trim() === '');

const a5 = runHook('Bash', { command: 'podman run --env-file=.env img' });
ok('hook allows Bash(podman run --env-file=.env img) end-to-end (exit 0, no output)', a5.code === 0 && a5.out.trim() === '');

const d3 = runHook('Bash', { command: 'cat .env' });
ok('hook still denies Bash(cat .env) end-to-end (exit 2, block decision)', d3.code === 2 && /"decision":"block"/.test(d3.out));

// --- template env files (.env.example/.sample/.template/.dist) are not secrets ---
const allowCmd = (c) => ok(`Bash \`${c}\` is allowed`, !detectSecretRead('Bash', { command: c }));
const denyCmd = (c) => ok(`Bash \`${c}\` is denied`, !!detectSecretRead('Bash', { command: c }));
ok('Read .env.example is allowed', !detectSecretRead('Read', { file_path: '.env.example' }));
ok('Read .env.local.example is allowed', !detectSecretRead('Read', { file_path: 'app/.env.local.example' }));
ok('Read .ENV.SAMPLE is allowed', !detectSecretRead('Read', { file_path: '.ENV.SAMPLE' }));
allowCmd('cat .env.template');
allowCmd('cat .env.dist');
ok('Read .env.example.bak is still denied', !!detectSecretRead('Read', { file_path: '.env.example.bak' }));
ok('Read .env.examples is still denied', !!detectSecretRead('Read', { file_path: '.env.examples' }));

// --- name-only operand positions: git pathspecs, cp/mv destination ---
// Questi comandi non stampano mai il contenuto del file: sono i controlli che
// tengono un segreto fuori da git, e il guard non deve bloccarli.
allowCmd('git check-ignore -v .env');
allowCmd('git check-ignore -q .env .secrets');
allowCmd('git ls-files --error-unmatch .env');
allowCmd('git ls-files -ci --exclude-standard -- .env');
allowCmd('git rm --cached .env');
allowCmd('git rm -r --cached -f .env');
allowCmd('git -C app check-ignore .env');
allowCmd('git --no-pager ls-files .env');
allowCmd('cp .env.example .env');
allowCmd('cp -f .env.example .env');
allowCmd('mv .env.sample .env');
allowCmd('cp -- .env.example .env');
allowCmd('git check-ignore .env && cp .env.example .env');
// Fail-closed: forme che leggono, o fuori dal set di opzioni chiuso.
denyCmd('git show HEAD:.env');
denyCmd('git rm .env');
denyCmd('git rm -- --cached .env');
denyCmd('git rm --cached --pathspec-from-file=.env');
denyCmd('git ls-files -X .env');
denyCmd('git ls-files -ciX .env');
denyCmd('git -C ls-files show HEAD:.env');
denyCmd('git --unknown check-ignore .env');
denyCmd('git diff .env');
denyCmd('cp .env /tmp/x');
denyCmd('cp .env .env.bak');
denyCmd('mv .env /tmp/x');
denyCmd('cp -t /tmp .env.example .env');
denyCmd('cp .env.example .env /tmp');
denyCmd('cp -b .env.example .env');
denyCmd('cp --backup .env.example .env');
denyCmd('cp -l .env.example .env');
denyCmd('cp -s .env.example .env');
denyCmd('mv --exchange .env.example .env');
denyCmd('cp .env.example .env -f');
denyCmd('cp .env.example .env && cat .env');
denyCmd('git check-ignore .env; cat .env');

// #214: a secret read inside a command substitution, even double-quoted
const hit214 = (c) => { const r = detectSecretRead('Bash', { command: c }); return !!r && r.path === '.env'; };
for (const c of ['echo "$(true; cat .env)"', 'echo "$(cat .env)"', 'x="$(cat .env)"', 'diff <(cat .env) x',
  'echo "$(echo "$(cat .env)")"', 'echo "$(\ncat .env\n)"']) {
  ok(`Bash \`${c}\` is denied with path .env (#214)`, hit214(c));
}
allowCmd("echo '$(cat .env)'");
allowCmd('echo "$(echo hi)"');
allowCmd('echo "$((1+2))"');
allowCmd('git commit -m "document .env usage"');

// #214 review: heredoc inside a substitution, substitution inside arithmetic
for (const c of ['echo "$(cat <<E\nfoo\nE\n; cat .env)"', 'echo $(cat <<E\nfoo\nE\n; cat .env)',
  'echo "$(( $(cat .env) ))"', 'echo $(( $(cat .env) ))', 'echo "$[ $(cat .env) ]"']) {
  ok(`Bash \`${c}\` is denied with path .env (#214 review)`, hit214(c));
}
allowCmd('echo "$((1+2))"');
allowCmd('echo $((a+(b)))');
allowCmd('echo "$(( $(echo 1) + 1 ))"');

// #216: a secret read inside a backtick substitution, even double-quoted
for (const c of ['echo "`cat .env`"', 'x="`cat .env`"', 'echo "${x:-`cat .env`}"', 'echo `cat .env`',
  'echo "$(echo `cat .env`)"', 'echo `echo $(cat .env)`', 'echo `echo \\`cat .env\\``']) {
  ok(`Bash \`${c}\` is denied with path .env (#216)`, hit214(c));
}
for (const c of ['echo "`echo \'"\'`"; cat .env', 'echo `true\ncat .env\n`',
  'echo `echo \\`echo \\\\\\`cat .env\\\\\\`\\``']) {
  ok(`Bash \`${c}\` is denied with path .env (#216 review)`, hit214(c));
}
{ // \" inside a double-quoted backtick body: bash reads the quoted .env (the path keeps its quotes)
  const r = detectSecretRead('Bash', { command: 'echo "`cat \\".env\\"`"' });
  ok('Bash `echo "`cat \\".env\\"`"` is denied (#216 review)', !!r && /\.env/.test(r.path));
}
allowCmd('echo "run `ls` then `pwd`"');
allowCmd("echo '`cat .env`'");
allowCmd('echo "\\`cat .env\\`"');

// #218: a secret read inside the body of an UNQUOTED heredoc (the shell runs $(..) and backticks there)
for (const c of ['cat <<EOF\n$(cat .env)\nEOF', 'cat <<EOF\n`cat .env`\nEOF', 'cat <<-EOF\n\t$(cat .env)\n\tEOF',
  "cat <<EOF\nit's $(cat .env)\nEOF", 'cat <<EOF\nsay "hi $(cat .env)\nEOF', 'cat <<EOF\n${x:-$(cat .env)}\nEOF',
  'cat <<EOF\nfirst line\nthen text $(cat .env) more\nEOF', 'x=$(cat <<EOF\n$(cat .env)\nEOF\n)',
  'cat <<A\n$(cat <<B\n)\nB\ncat .env)\nA', 'cat <<EOF\n$\\\n(cat .env)\nEOF', 'cat <<EOF\n$(cat .e\\\nnv)\nEOF',
  'cat <<EOF\n$(cat \\\n.env)\nEOF', "cat <<A <<'B'\n$(cat .env)\nA\nx\nB"]) {
  ok(`Bash \`${c}\` is denied with path .env (#218)`, hit214(c));
}
for (const c of ["cat <<'EOF'\n$(cat .env)\nEOF", 'cat <<"EOF"\n$(cat .env)\nEOF', "cat <<'EOF'\n`cat .env`\nEOF",
  'cat <<EOF\n$$(cat .env)\nEOF', "cat <<A <<'B'\nx\nA\n$(cat .env)\nB",
  'cat <<EOF\n\\$(cat .env)\nEOF', 'cat <<EOF\n\\`cat .env\\`\nEOF', 'cat <<EOF\ncat .env\nEOF']) {
  allowCmd(c);
}

// #223: a heredoc body fed to a shell interpreter on stdin is a script, whatever the delimiter quoting
for (const c of ["bash <<'EOF'\ncat .env\nEOF", 'sh <<EOF\ncat .env\nEOF', 'bash <<EOF\ncat .env\nEOF',
  'cat <<EOF | bash\ncat .env\nEOF', 'zsh -s <<EOF\ncat .env\nEOF', 'VAR=1 bash <<EOF\ncat .env\nEOF',
  'env FOO=1 bash <<EOF\ncat .env\nEOF', '/bin/bash <<EOF\ncat .env\nEOF', 'dash <<EOF\ncat .env\nEOF',
  'env -i FOO=1 ksh <<EOF\ncat .env\nEOF', "cat <<'EOF' | sh\ncat .env\nEOF", 'bash -x <<EOF\necho $(cat .env)\nEOF',
  'echo hi; bash <<EOF\ncat .env\nEOF']) {
  ok(`Bash \`${c}\` is denied with path .env (#223)`, hit214(c));
}
// #223 review: env option values, leading shell keywords, heredoc pairing
for (const c of ['env -u FOO bash <<EOF\ncat .env\nEOF', 'env -C /tmp bash <<EOF\ncat .env\nEOF',
  'env --unset FOO sh <<EOF\ncat .env\nEOF', 'env --chdir /tmp bash <<EOF\ncat .env\nEOF',
  'env -S bash <<EOF\ncat .env\nEOF', 'if true; then bash <<EOF\ncat .env\nEOF', 'time bash <<EOF\ncat .env\nEOF',
  'while x; do bash <<EOF\ncat .env\nEOF', '! bash <<EOF\ncat .env\nEOF', 'true; then time bash <<EOF\ncat .env\nEOF',
  'cat <<EOF |& bash\ncat .env\nEOF', 'bash <<EOF &\ncat .env\nEOF', 'cat <<A; bash <<B\necho hi\nA\ncat .env\nB']) {
  ok(`Bash \`${c}\` is denied with path .env (#223 review)`, hit214(c));
}
allowCmd('cat <<A; bash <<B\ncat .env\nA\necho hi\nB');

for (const c of ["cat <<'EOF'\ncat .env\nEOF", 'cat <<EOF\ncat .env\nEOF', "tee f <<'EOF'\ncat .env\nEOF",
  'cat <<EOF; bash x.sh\ncat .env\nEOF', "bash <<'EOF'\necho hi\nEOF", 'cat <<EOF | bash\necho hi\nEOF']) {
  allowCmd(c);
}

// #214: deep nesting is bounded (explicit work-list, capped), never a stack overflow
{
  const nest = (n, inner) => 'echo ' + '"$('.repeat(n) + inner + ')"'.repeat(n);
  for (const n of [40, 2000, 6000]) {
    const t0 = Date.now();
    const r = detectSecretRead('Bash', { command: nest(n, 'cat .env') });
    const ms = Date.now() - t0;
    ok(`nesting n=${n} with a secret is denied with path .env`, !!r && r.path === '.env');
    ok(`nesting n=${n} with a secret completes under 1s (${ms}ms)`, ms < 1000);
  }
  const t1 = Date.now();
  const clean = detectSecretRead('Bash', { command: nest(6000, 'cat README.md') });
  const ms1 = Date.now() - t1;
  ok('deep nesting with no secret is allowed', clean === null);
  ok(`deep nesting with no secret completes under 1s (${ms1}ms)`, ms1 < 1000);
}

const a6 = runHook('Bash', { command: 'git check-ignore -v .env' });
ok('hook allows Bash(git check-ignore -v .env) end-to-end (exit 0, no output)', a6.code === 0 && a6.out.trim() === '');
const a7 = runHook('Bash', { command: 'cp .env.example .env' });
ok('hook allows Bash(cp .env.example .env) end-to-end (exit 0, no output)', a7.code === 0 && a7.out.trim() === '');

// --- #227: constructs the guard cannot interpret, near a secret-looking piece ---
{
  const CODE = 'SECRET_READ_UNMODELLED_CONSTRUCT';
  const code = (command) => { const r = runHook('Bash', { command }); return r.code === 2 ? JSON.parse(r.out).code : null; };
  for (const c of [
    'eval cat .e""nv',
    'eval "cat .e\'\'nv"',
    'echo ${ cat .e""nv; }',
    'echo ${| cat .e""nv; }',
    'source .e""nv',
    '. .e""nv && make',
    'printf -v x %s .e""nv',
    "alias c='cat .e\"\"nv'",
    "alias c='cat .env'; c",
    'f() { cat .e""nv; }; f',
    'echo "${ cat .e""nv; }"',
    'x=$(source .e""nv)',
  ]) {
    const hit = detectSecretRead('Bash', { command: c });
    ok(`denies an unmodelled construct near a secret piece: ${c}`, !!hit && !!hit.unmodelled);
    ok(`... with the unmodelled code (exit 2): ${c}`, code(c) === CODE);
  }
  ok('a quoted api body key mentioning .env in prose is not a read', detectSecretRead('Bash', { command: "gh api -X PATCH repos/a/b/issues/1 -f 'body'='document the .env file'" }) === null);
  ok('... and the hook allows it', runHook('Bash', { command: "gh api -X PATCH repos/a/b/issues/1 -f 'body'='document the .env file'" }).code === 0);
  // The precise scan keeps priority and its code.
  ok('a precise read keeps SECRET_READ_BLOCKED', code('eval cat .env') === 'SECRET_READ_BLOCKED');
  ok('a precise read inside a function body keeps SECRET_READ_BLOCKED', code('f() { cat .env; }; f') === 'SECRET_READ_BLOCKED');
  ok('detectSecretRead keeps { path } for a precise read', (() => { const h = detectSecretRead('Bash', { command: 'cat .env' }); return h && h.path === '.env' && !h.unmodelled; })());
  // Plain controls pass: the construct has no secret-looking piece near it.
  for (const c of [
    '. venv/bin/activate && make',
    'source ~/.venv/bin/activate && pytest',
    "alias ll='ls -l'",
    'alias g=gh; g issue list',
    'eval "$(ssh-agent)"',
    'printf -v x %s y; echo $x',
    'f() { ls; }; f',
    'echo ${ date; }',
    'echo "alias .environment"',
    'cat .e\\\n  nv.md',
  ]) ok(`allows a construct with no secret piece: ${c}`, detectSecretRead('Bash', { command: c }) === null && runHook('Bash', { command: c }).code === 0);
  const r = runHook('Bash', { command: 'echo ${ cat .e""nv; }' });
  const reason = JSON.parse(r.out).reason;
  ok('the message names the guard and asks for the simple form', /^trailhead secret-read guard: /.test(reason) && /Rewrite it in a simple form/.test(reason));
  const T = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'.slice(0, 36);
  const leak = JSON.parse(runHook('Bash', { command: `echo \${ cat .e""nv; echo ${T}; }` }).out).reason;
  ok('the message never echoes a token', !leak.includes(T) && !leak.includes('ghp_'));
}

// --- #273: a git config value that names a command (git -c / --config-env) ---
{
  const blocked = (c) => !!detectSecretRead('Bash', { command: c });
  const unmodelled = (c) => { const h = detectSecretRead('Bash', { command: c }); return !!h && !!h.unmodelled; };
  const exit2 = (c) => { const r = runHook('Bash', { command: c }); return r.code === 2 && JSON.parse(r.out).code === 'SECRET_READ_BLOCKED'; };
  for (const c of [
    'git -c alias.x="!cat .env" x',
    'git -c core.pager="cat .env" log',
    'git -c core.sshCommand="cat .env" fetch',
  ]) ok(`end to end: ${c} exits 2 SECRET_READ_BLOCKED`, exit2(c));
  for (const c of [
    'git -c alias.x="!cat .env" x',
    "git -c alias.x='!cat .env' x",
    'git -c pager.log="cat .env" log',
    'git -c core.editor="cat .env" commit',
    'git -c sequence.editor="cat .env" rebase -i HEAD~2',
    'git -c core.fsmonitor="cat .env" status',
    'git -c diff.external="cat .env" diff',
    'git -c diff.foo.textconv="cat .env" diff',
    'git -c filter.foo.clean="cat .env" add x',
    'git -c filter.foo.smudge="cat .env" checkout x',
    'git -c filter.foo.process="cat .env" checkout x',
    'git -c credential.helper="!cat .env" fetch',
    'git -c gpg.program="cat .env" commit -S',
    'git -c CORE.PAGER="cat .env" log',
    'git -c Core.SshCommand="cat .env" fetch',
    'git -ccore.pager="cat .env" log',
    "git -calias.x='!cat .env' x",
    'git -C /tmp -c core.pager="cat .env" log',
    'git --no-pager -c core.pager="cat .env" -c user.name=a log',
    '/usr/bin/git -c core.pager="cat .env" log',
    'FOO=1 git -c core.pager="cat .env" log',
    'echo hi && git -c core.pager="cat .env" log',
    'git -c core.pager="head $(cat .env)" log',
    'git -c alias.x="!f() { cat .env; }; f" x',
    'git -c core.pager=".env" log',
    'P="cat .env" git --config-env=core.pager=P log',
    'P="cat .env" git --config-env core.pager=P log',
    'P="!cat .env" git --config-env=alias.x=P x',
    "P='cat .env' /usr/bin/git -C /tmp --config-env=core.sshCommand=P fetch",
  ]) ok(`denies a command-valued git config: ${c}`, blocked(c));
  for (const c of [
    'git -c core.pager=less log',
    'git -c user.name=.env commit',
    'git -c credential.helper=store fetch',
    'git -c alias.x="cat .env" x',
    'git -c alias.x=".env" x',
    'git -c credential.helper="cat .env" fetch',
    'git -c user.name=.env -c core.pager=less log',
    'git -c core.pager="less" -C /tmp log',
    'git -C /tmp log',
    'git -c core.autocrlf log',
    'git -c alias.x log',
    'git --config-env=user.name=NAME log',
    'git --config-env user.name=NAME log',
    'git --config-env=core.autocrlf=UNSET_VAR log',
    'P=less git --config-env=core.pager=P log',
    'P=less git --config-env core.pager=P log',
    'P="!less" git --config-env=alias.x=P x',
    'P=store git --config-env=credential.helper=P fetch',
    'git log -c core.pager="cat .env"',
    'echo -c core.pager="cat .env"',
  ]) ok(`allows a harmless git config: ${c}`, !blocked(c));
  for (const c of [
    'git --config-env=core.pager=P log',
    'git --config-env core.pager=P log',
    'Q=less git --config-env=core.pager=P log',
    'git --config-env=alias.x=P x',
    'git -C /tmp --config-env=core.sshCommand=P fetch',
  ]) {
    ok(`blocks an unresolved --config-env on a command key as unmodelled: ${c}`, unmodelled(c));
    const r = runHook('Bash', { command: c });
    ok(`end to end: ${c} exits 2 SECRET_READ_UNMODELLED_CONSTRUCT`, r.code === 2 && JSON.parse(r.out).code === 'SECRET_READ_UNMODELLED_CONSTRUCT');
  }
  ok('a resolved secret --config-env stays SECRET_READ_BLOCKED, not unmodelled', !unmodelled('P="cat .env" git --config-env=core.pager=P log'));
}

// --- #273 review C1/I3: a git global option the walk does not list must not hide a later -c ---
{
  const blocked = (c) => !!detectSecretRead('Bash', { command: c });
  const unmodelled = (c) => { const h = detectSecretRead('Bash', { command: c }); return !!h && !!h.unmodelled; };
  for (const c of [
    'git --literal-pathspecs -c core.pager="cat .env" log',
    'git --glob-pathspecs -c core.pager="cat .env" log',
    'git --noglob-pathspecs -c core.pager="cat .env" log',
    'git --icase-pathspecs -c core.pager="cat .env" log',
    'git --exec-path=/x -c core.pager="cat .env" log',
    'git --exec-path -c core.pager="cat .env" log',
    'git --attr-source=x -c core.pager="cat .env" log',
    'git --list-cmds=main -c core.pager="cat .env" log',
    'git --some-future-flag -c core.pager="cat .env" log',
  ]) ok(`denies a config command behind a global option: ${c}`, blocked(c));
  ok('an unresolved --config-env behind a global option is unmodelled',
    unmodelled('git --exec-path=/x --config-env=core.pager=P log'));
  ok('a harmless -c behind a global option is allowed', !blocked('git --literal-pathspecs -c core.pager=less log'));
  ok('git show behind --attr-source stays a subcommand walk', blocked('git --attr-source=x show HEAD:.env'));
  ok('git --attr-source x ls-files .env stays name-only', !blocked('git --attr-source x ls-files .env'));
}

// --- #273 review W2: backslash escapes in a quoted config value ---
{
  const blocked = (c) => !!detectSecretRead('Bash', { command: c });
  for (const c of [
    'git -c core.pager="sh -c \\"cat .env\\"" log',
    'git -c core.pager="bash -c \'bash -c \\"cat .env\\"\'" log',
    'git -c core.pager="git -c core.pager=\\"cat .env\\" log" log',
    'git -c core.pager=cat\\ .env log',
  ]) ok(`denies an escaped config command: ${c}`, blocked(c));
  ok('single quotes keep a backslash literal', !blocked("git -c core.pager='less \\' log"));
  ok('an escaped dollar stays literal text, not a path', !blocked('git -c core.pager="less \\$x" log'));
}

// --- #273 review W1: config and commands injected through leading env assignments ---
{
  const blocked = (c) => !!detectSecretRead('Bash', { command: c });
  const unmodelled = (c) => { const h = detectSecretRead('Bash', { command: c }); return !!h && !!h.unmodelled; };
  for (const c of [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0="cat .env" git log',
    'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=a GIT_CONFIG_KEY_1=alias.x GIT_CONFIG_VALUE_1="!cat .env" git x',
    'GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0="cat .env" git log',
    "GIT_CONFIG_PARAMETERS=\"'core.pager=cat .env'\" git log",
    "GIT_CONFIG_PARAMETERS=\"'user.name'='a' 'core.pager'='cat .env'\" git log",
    "GIT_CONFIG_PARAMETERS=\"'alias.x=!cat .env'\" git x",
    'GIT_PAGER="cat .env" git log',
    'PAGER="cat .env" git log',
    'GIT_SSH_COMMAND="cat .env" git fetch',
    'GIT_SSH="cat .env" git fetch',
    'GIT_EXTERNAL_DIFF="cat .env" git diff',
    'GIT_EDITOR="cat .env" git commit',
    'GIT_SEQUENCE_EDITOR="cat .env" git rebase -i HEAD~2',
    'EDITOR="cat .env" git commit',
    'VISUAL="cat .env" git commit',
    'GIT_ASKPASS="cat .env" git fetch',
    'SSH_ASKPASS="cat .env" git fetch',
  ]) ok(`denies an env-injected git command: ${c}`, blocked(c));
  for (const c of [
    'GIT_PAGER=less git log',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=.env git commit',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0="cat .env" git x',
    "GIT_CONFIG_PARAMETERS=\"'user.name=.env'\" git commit",
    'GIT_SSH_COMMAND="ssh -i ~/.ssh/id" git fetch',
    'PAGER="cat .env" echo hi',
    'GIT_PAGER="cat .env"',
  ]) ok(`allows a harmless env-injected value: ${c}`, !blocked(c));
  ok('an unparsable GIT_CONFIG_PARAMETERS on a command key is unmodelled',
    unmodelled("GIT_CONFIG_PARAMETERS=\"'core.pager=less\" git log"));
}

// --- crash safety ---
const crash1 = runHook('Read', undefined);
ok('missing tool_input never crashes (exit 0)', crash1.code === 0);

// --- #227: a missing unmodelled lib degrades to the previous behaviour ---
{
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srg-nolib-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  for (const f of fs.readdirSync(path.join(__dirname, 'lib'))) {
    if (/\.(js|json)$/.test(f) && !f.endsWith('.test.js') && f !== 'unmodelled.js') fs.copyFileSync(path.join(__dirname, 'lib', f), path.join(dir, 'lib', f));
  }
  fs.copyFileSync(path.join(__dirname, 'trailhead-secret-read-guard.js'), path.join(dir, 'trailhead-secret-read-guard.js'));
  const bare = require(path.join(dir, 'trailhead-secret-read-guard.js'));
  ok('without the unmodelled lib the guard still loads and denies a precise read', !!bare.detectSecretRead('Bash', { command: 'cat .env' }));
  ok('without the unmodelled lib the unmodelled gate is off', bare.detectSecretRead('Bash', { command: 'source .e""nv' }) === null);
  fs.rmSync(dir, { recursive: true });
}


// --- #275: more command-valued git config keys, and `git config` writing one ---
{
  const blocked = (c) => !!detectSecretRead('Bash', { command: c });
  const keys = [
    'core.askPass', 'core.gitProxy', 'mergetool.x.cmd', 'difftool.x.cmd', 'merge.x.driver',
    'browser.x.cmd', 'man.x.cmd', 'uploadpack.packObjectsHook', 'diff.x.command',
    'core.askpass', 'uploadpack.packobjectshook', 'MERGETOOL.X.CMD',
  ];
  for (const k of keys) {
    ok(`denies git -c ${k}="cat .env"`, blocked(`git -c ${k}="cat .env" status`));
    ok(`denies git -c${k}="cat .env" (glued)`, blocked(`git -c${k}="cat .env" status`));
    ok(`allows git -c ${k}=less`, !blocked(`git -c ${k}=less status`));
    ok(`allows git -c ${k}=true`, !blocked(`git -c ${k}=true status`));
  }
  ok('denies --config-env on a new key with an assigned var', blocked('P="cat .env" git --config-env=core.askPass=P status'));
  ok('allows --config-env on a new key with a harmless var', !blocked('P=less git --config-env=core.askPass=P status'));
  ok('denies GIT_CONFIG_KEY_0/VALUE_0 on a new key',
    blocked('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=uploadpack.packObjectsHook GIT_CONFIG_VALUE_0="cat .env" git status'));
  ok('denies GIT_CONFIG_PARAMETERS on a new key', blocked(`GIT_CONFIG_PARAMETERS="'merge.x.driver=cat .env'" git status`));
  ok('allows GIT_CONFIG_PARAMETERS with a harmless value', !blocked(`GIT_CONFIG_PARAMETERS="'merge.x.driver=true'" git status`));

  for (const c of [
    'git config core.pager "cat .env"',
    'git config alias.x "!cat .env"',
    'git config --global core.pager "cat .env"',
    'git config set core.pager "cat .env"',
    'git config -f cfg core.askPass "cat .env"',
    'git config --file=cfg core.pager "cat .env"',
    'git config --file cfg core.pager "cat .env"',
    'git config --add alias.y "!cat .env"',
    'git -C /tmp config core.pager "cat .env"',
    'git config --local --type=path core.editor "cat .env"',
    'git config mergetool.x.cmd "cat .env"',
    'git config --some-future-flag core.pager "cat .env"',
  ]) ok(`denies a git config write of a command: ${c}`, blocked(c));
  for (const c of [
    'git config core.pager less',
    'git config alias.x "!echo hi"',
    'git config alias.x "cat .env"',
    'git config user.name "cat .env"',
    'git config --get core.pager',
    'git config core.pager=less',
    'git config --global core.pager less',
    'git config set core.pager less',
    'git config --list',
    'git config get core.pager',
    'git config --unset core.pager',
    'git config -f cfg core.pager less',
  ]) ok(`allows a harmless git config: ${c}`, !blocked(c));
}

// #275: `--` ends git config options, so a dash-leading value is still the value.
for (const command of [
  `git config core.pager -- '-n; cat .env'`,
  `git config -- core.pager '-n; cat .env'`,
]) {
  ok(`#275 deny: ${command}`, !!detectSecretRead('Bash', { command }));
}
ok('#275 allow: git config -- core.pager less', !detectSecretRead('Bash', { command: 'git config -- core.pager less' }));

console.log(`✓ secret-read-guard: ${passed} assertions passed`);
