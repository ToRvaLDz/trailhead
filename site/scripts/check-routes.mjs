#!/usr/bin/env node
// Seam test for the site scaffold: asserts the static build produced the
// expected routes (landing at /, docs at /docs/...). Run it via `npm run
// check`, which builds first so the assertions never pass against a stale
// dist/; `npm run check:routes` runs the bare assertion against the current
// dist/.
//
// The `dist/en` negative assertion guards one specific regression: `en`
// becoming a NON-default (prefixed) locale, which would re-introduce /en/...
// routes. Note Starlight leaves the *default* locale unprefixed whatever it is
// named, so the benign `locales: { en }`-as-default substitution stays at
// /docs/ (and a mismatched defaultLocale hard-fails the build instead); this
// check catches the prefixed-locale case, not that substitution.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const siteRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(siteRoot, 'dist');

const mustExist = [
  path.join(dist, 'index.html'),
  path.join(dist, 'docs', 'index.html'),
  path.join(dist, 'docs', 'getting-started', 'index.html'),
];

const mustNotExist = [path.join(dist, 'en')];

// Landing-content assertions: guard against the real landing regressing back
// to the build/routing skeleton placeholder, and assert the install/CTA copy
// that the approved mockup requires is actually present in the built HTML.
const landingIndex = path.join(dist, 'index.html');
const landingMustContain = [
  '/plugin marketplace add ToRvaLDz/trailhead',
  '/plugin install trailhead@trailhead',
  'npx @marcomigozzi/trailhead',
  '--codex',
  'github.com/ToRvaLDz/trailhead',
  '/docs/',
];
const landingMustNotContain = ['Skeleton placeholder'];

const failures = [];

for (const file of mustExist) {
  if (!existsSync(file)) {
    failures.push(`missing expected build output: ${path.relative(siteRoot, file)}`);
  }
}

for (const file of mustNotExist) {
  if (existsSync(file)) {
    failures.push(
      `unexpected build output present (i18n prefix regression): ${path.relative(siteRoot, file)}`
    );
  }
}

if (existsSync(landingIndex)) {
  const landingHtml = readFileSync(landingIndex, 'utf8');
  for (const needle of landingMustContain) {
    if (!landingHtml.includes(needle)) {
      failures.push(`landing (dist/index.html) missing expected content: ${needle}`);
    }
  }
  for (const needle of landingMustNotContain) {
    if (landingHtml.includes(needle)) {
      failures.push(`landing (dist/index.html) still contains placeholder content: ${needle}`);
    }
  }
}

if (failures.length > 0) {
  console.error('check-routes: FAILED');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('check-routes: OK — landing, /docs/, and /docs/getting-started all resolved, no /en prefix.');
process.exit(0);
