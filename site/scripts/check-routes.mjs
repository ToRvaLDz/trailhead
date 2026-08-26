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

// Per-page hero illustrations (#112): every /docs/* page renders exactly one
// decorative map-card hero as a full-width banner below the real
// `<h1 id="_top">`, keyed by `data-illustration`. Keyed by the illustration
// key -> its built HTML file, so a missing file is a hard failure rather
// than a silently skipped assertion (the `existsSync`-gated blocks above
// intentionally skip when a file is absent; these must not).
const heroCardsByKey = {
  overview: path.join(dist, 'docs', 'index.html'),
  'getting-started': path.join(dist, 'docs', 'getting-started', 'index.html'),
  concepts: path.join(dist, 'docs', 'concepts', 'index.html'),
  workflow: path.join(dist, 'docs', 'workflow', 'index.html'),
  'ticket-types': path.join(dist, 'docs', 'ticket-types', 'index.html'),
  commands: path.join(dist, 'docs', 'commands', 'index.html'),
  captures: path.join(dist, 'docs', 'captures', 'index.html'),
  teamwork: path.join(dist, 'docs', 'teamwork', 'index.html'),
  configuration: path.join(dist, 'docs', 'configuration', 'index.html'),
  hooks: path.join(dist, 'docs', 'hooks', 'index.html'),
};

const heroMarkerAttr = 'data-docs-hero';
// Robust to either attribute order on the hero root element.
const heroAriaHiddenPattern =
  /data-docs-hero="true"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-docs-hero="true"/;
const notFoundIndex = path.join(dist, '404.html');

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

for (const [key, file] of Object.entries(heroCardsByKey)) {
  if (!existsSync(file)) {
    failures.push(`docs hero (${key}): missing expected build output: ${path.relative(siteRoot, file)}`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  if (!html.includes(heroMarkerAttr)) {
    failures.push(`docs hero (${key}): missing ${heroMarkerAttr}`);
  }
  if (!html.includes(`data-illustration="${key}"`)) {
    failures.push(`docs hero (${key}): missing data-illustration="${key}"`);
  }
  // Robust to Astro splitting the inline SVG across many nodes: count the
  // literal attribute name (with the trailing `=`), not the whole element.
  const heroMarkerCount = html.split(`${heroMarkerAttr}=`).length - 1;
  if (heroMarkerCount !== 1) {
    failures.push(
      `docs hero (${key}): expected exactly one ${heroMarkerAttr} occurrence, found ${heroMarkerCount}`
    );
  }
  const h1Count = html.split('<h1 id="_top"').length - 1;
  if (h1Count !== 1) {
    failures.push(`docs hero (${key}): expected exactly one <h1 id="_top"> occurrence, found ${h1Count}`);
  }
  // #112: the hero is decorative and must never be announced before the
  // real title — assert it self-hides via aria-hidden.
  if (!heroAriaHiddenPattern.test(html)) {
    failures.push(`docs hero (${key}): missing aria-hidden="true" on the hero element`);
  }
  // #112: the hero is a banner at the top of the content, so it must render
  // AFTER the real <h1 id="_top"> (which the stock PageTitle emits above it),
  // not before it.
  const heroIndex = html.indexOf(`${heroMarkerAttr}=`);
  const h1Index = html.indexOf('<h1 id="_top"');
  if (!(heroIndex > h1Index)) {
    failures.push(`docs hero (${key}): expected hero to appear after <h1 id="_top"> in the built HTML`);
  }
}

// Negative assertions: the hero marker must never leak onto the landing page
// or a 404/system route.
if (existsSync(landingIndex)) {
  const landingHtml = readFileSync(landingIndex, 'utf8');
  if (landingHtml.includes(heroMarkerAttr)) {
    failures.push(`landing (dist/index.html) unexpectedly contains ${heroMarkerAttr}`);
  }
}

if (existsSync(notFoundIndex)) {
  const notFoundHtml = readFileSync(notFoundIndex, 'utf8');
  if (notFoundHtml.includes(heroMarkerAttr)) {
    failures.push(`404 (dist/404.html) unexpectedly contains ${heroMarkerAttr}`);
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
  'check-routes: OK — landing and all 10 /docs/* pages resolved, no /en prefix, install/verb facts present, no placeholder copy left, all 10 per-page hero markers present (full-width banner below the title, aria-hidden).'
);
process.exit(0);
