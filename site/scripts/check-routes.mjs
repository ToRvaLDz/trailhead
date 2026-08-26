#!/usr/bin/env node
// Seam test for the site scaffold: asserts the static build produced the
// expected routes, and guards against the Starlight i18n `locales: { en }`
// misconfiguration that would prefix routes as /en/... instead of serving
// English unprefixed at / and /docs/.
import { existsSync } from 'node:fs';
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

if (failures.length > 0) {
  console.error('check-routes: FAILED');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('check-routes: OK — landing, /docs/, and /docs/getting-started all resolved, no /en prefix.');
process.exit(0);
