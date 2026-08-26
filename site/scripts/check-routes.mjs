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

const docsSlugs = [
  'getting-started',
  'concepts',
  'workflow',
  'ticket-types',
  'commands',
  'captures',
  'teamwork',
  'configuration',
  'hooks',
];

const mustExist = [
  path.join(dist, 'index.html'),
  path.join(dist, 'docs', 'index.html'),
  ...docsSlugs.map((slug) => path.join(dist, 'docs', slug, 'index.html')),
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

// Normalize a built HTML file's text for volatile-fact assertions: Shiki /
// Expressive Code split code samples across many inline `<span>`s, so a raw
// substring match against the HTML breaks even when the rendered text is
// intact. Strip tags, decode the handful of entities that show up in code
// samples and prose, then collapse whitespace.
function normalizedText(file) {
  const html = readFileSync(file, 'utf8');
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const gettingStartedIndex = path.join(dist, 'docs', 'getting-started', 'index.html');
const gettingStartedMustContain = [
  '/plugin marketplace add ToRvaLDz/trailhead',
  '/plugin install trailhead@trailhead',
  'npx @marcomigozzi/trailhead',
  '--codex',
];

const commandsIndex = path.join(dist, 'docs', 'commands', 'index.html');
const commandsMustContain = [
  '/trailhead:new',
  '/trailhead:adopt',
  '/trailhead:work',
  '/trailhead:quick',
  '/trailhead:whiteboard',
  '/trailhead:inbox',
  '/trailhead:resume',
  '/trailhead:pause',
  '/trailhead:ticket',
  '/trailhead:split',
  '/trailhead:grill',
  '/trailhead:map',
  '/trailhead:dashboard',
  '/trailhead:todo',
  '/trailhead:seed',
  '/trailhead:idea',
  '/trailhead:note',
  '/trailhead:bug',
  '/trailhead:config',
  '/trailhead:update',
];

const docsPlaceholder = 'Skeleton placeholder';

// Docs-brand assertions: the /docs/ section must be themed to the landing
// brand (dark-only) — the header renders the same wordmark as the landing
// nav, and Starlight's light/dark/auto theme picker is gone (the custom
// element it registers itself as must not appear in the markup).
const docsBrandIndex = path.join(dist, 'docs', 'index.html');
const docsBrandInnerPage = path.join(dist, 'docs', 'concepts', 'index.html');
const themeSelectTag = '<starlight-theme-select';
const brandWordmarkAttr = 'data-brand-wordmark';

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

if (existsSync(gettingStartedIndex)) {
  const text = normalizedText(gettingStartedIndex);
  for (const needle of gettingStartedMustContain) {
    if (!text.includes(needle)) {
      failures.push(`docs/getting-started missing expected content: ${needle}`);
    }
  }
}

if (existsSync(commandsIndex)) {
  const text = normalizedText(commandsIndex);
  for (const needle of commandsMustContain) {
    if (!text.includes(needle)) {
      failures.push(`docs/commands missing expected verb: ${needle}`);
    }
  }
}

for (const file of [docsBrandIndex, docsBrandInnerPage]) {
  if (existsSync(file)) {
    const html = readFileSync(file, 'utf8');
    const label = path.relative(siteRoot, file);
    if (!html.includes(brandWordmarkAttr)) {
      failures.push(`${label} missing brand wordmark seam attribute: ${brandWordmarkAttr}`);
    }
    if (html.includes(themeSelectTag)) {
      failures.push(`${label} still renders the Starlight theme-select toggle (should be dark-only)`);
    }
  }
}

for (const slug of ['index', ...docsSlugs]) {
  const file = path.join(dist, 'docs', ...(slug === 'index' ? [] : [slug]), 'index.html');
  if (existsSync(file)) {
    const text = normalizedText(file);
    if (text.includes(docsPlaceholder)) {
      failures.push(`docs/${slug} still contains placeholder content: ${docsPlaceholder}`);
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

console.log(
  'check-routes: OK — landing and all 10 /docs/* pages resolved, no /en prefix, install/verb facts present, no placeholder copy left.'
);
process.exit(0);
