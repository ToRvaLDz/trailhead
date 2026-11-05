#!/usr/bin/env node
// La config globale su Codex sta in <codexHome>, non in ~/.claude: ogni lettore, copiato dove l'installer
// Codex lo mette, deve trovarla lì. Run: node global-config-dir.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginDir = path.resolve(__dirname, '..', '..');
const READERS = [
  ['templates', 'trailhead-base-preflight.js'],
  ['templates', 'trailhead-inbox-needs-info.js'],
  ['templates', 'trailhead-isolation-copy.js'],
  ['templates', 'trailhead-plan-review-rounds.js'],
  ['templates', 'trailhead-test-run.js'],
  ['templates', 'trailhead-uat-setup.js'],
  ['hooks', 'trailhead-test-guard.js'],
];

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trailhead-global-config-'));
const codexHome = path.join(tmp, 'codex');
const skillDir = path.join(codexHome, 'skills', 'trailhead');
const ENV = { HOME: path.join(tmp, 'home'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') };

// Il percorso del file di config che il lettore userebbe, con l'env dato.
const configFileOf = (mod, env) =>
  (mod.configDir ? path.join(mod.configDir(env), 'trailhead', 'config.json') : mod.globalConfigPath(env));

let passed = 0;
try {
  for (const dir of ['templates', 'hooks']) {
    fs.cpSync(path.join(pluginDir, dir), path.join(skillDir, dir), { recursive: true });
  }
  const expected = path.join(codexHome, 'trailhead', 'config.json');
  for (const [dir, file] of READERS) {
    const onCodex = require(path.join(skillDir, dir, file));
    assert.strictEqual(configFileOf(onCodex, ENV), expected, `${file} on Codex`);
    passed += 1;

    const onClaude = require(path.join(pluginDir, dir, file));
    assert.strictEqual(configFileOf(onClaude, ENV), path.join(ENV.CLAUDE_CONFIG_DIR, 'trailhead', 'config.json'), `${file} with CLAUDE_CONFIG_DIR`);
    assert.strictEqual(configFileOf(onClaude, { HOME: ENV.HOME }), path.join(ENV.HOME, '.claude', 'trailhead', 'config.json'), `${file} default`);
    passed += 2;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`global-config-dir.test.js: ${passed} checks passed`);
