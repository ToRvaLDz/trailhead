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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const siteRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(siteRoot, 'dist');

// #196: the verb guides, one page per engine cluster, each verb a section
// with a stable explicit anchor. The union is the 23 verbs of the index.
const commandClusters = {
  chart: ['new', 'adopt', 'ticket', 'inbox', 'grill'],
  work: ['work', 'quick', 'pause', 'resume', 'split', 'auto'],
  view: ['map', 'dashboard', 'whiteboard'],
  capture: ['todo', 'seed', 'idea', 'note', 'bug'],
  manage: ['config', 'update', 'prune', 'audit'],
};

const docsSlugs = [
  'getting-started',
  'concepts',
  'workflow',
  'ticket-types',
  'commands',
  ...Object.keys(commandClusters).map((cluster) => `commands/${cluster}`),
  'captures',
  'teamwork',
  'configuration',
  'hooks',
];

const mustExist = [
  path.join(dist, 'index.html'),
  path.join(dist, 'docs', 'index.html'),
  ...docsSlugs.map((slug) => path.join(dist, 'docs', slug, 'index.html')),
  // #117: 404.html must be built, else its existsSync-guarded checks (the
  // beacon assertion below and the hero-leak negative assertion) silently
  // no-op while the summary still claims 404 coverage.
  path.join(dist, '404.html'),
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
    .replace(/&#x3C;/gi, '<')
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
  '/trailhead:auto',
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
  '/trailhead:prune',
  '/trailhead:audit',
];

const docsPlaceholder = 'Skeleton placeholder';

// #117: Cloudflare Web Analytics beacon, cookieless, consent-free, must
// load on every published route (landing, every /docs/* page, and the 404).
const cfBeaconSrc = 'static.cloudflareinsights.com/beacon.min.js';
const cfBeaconToken = '9d745984ddba48329691930072aea137';

// Per-page hero illustrations (#112): every /docs/* page renders exactly one
// decorative map-card hero as a full-width banner below the real
// `<h1 id="_top">`, keyed by `data-illustration`. Keyed by the illustration
// key -> its built HTML file, so a missing file is a hard failure rather
// than a silently skipped assertion (the `existsSync`-gated blocks above
// intentionally skip when a file is absent; these must not).
const docsPage = (...segments) => path.join(dist, 'docs', ...segments, 'index.html');
const heroRoutes = [
  { file: path.join(dist, 'docs', 'index.html'), expectedKey: 'overview' },
  { file: docsPage('getting-started'), expectedKey: 'getting-started' },
  { file: docsPage('concepts'), expectedKey: 'concepts' },
  { file: docsPage('workflow'), expectedKey: 'workflow' },
  { file: docsPage('ticket-types'), expectedKey: 'ticket-types' },
  { file: docsPage('commands'), expectedKey: 'commands' },
  // #196: the cluster guides reuse the approved commands banner.
  ...Object.keys(commandClusters).map((cluster) => ({
    file: docsPage('commands', cluster),
    expectedKey: 'commands',
  })),
  { file: docsPage('captures'), expectedKey: 'captures' },
  { file: docsPage('teamwork'), expectedKey: 'teamwork' },
  { file: docsPage('configuration'), expectedKey: 'configuration' },
  { file: docsPage('hooks'), expectedKey: 'hooks' },
];

const heroMarkerAttr = 'data-docs-hero';
// Robust to either attribute order on the hero root element.
const heroAriaHiddenPattern =
  /data-docs-hero="true"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-docs-hero="true"/;
const notFoundIndex = path.join(dist, '404.html');

// Docs-brand assertions: the /docs/ section must be themed to the landing
// brand (dark-only), the header renders the same wordmark as the landing
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

// #196: the verb guides. Slice the raw built HTML of the article body only
// (never the Starlight TOC/sidebar, which repeat the heading labels), then cut
// it at each verb's explicit `<h3 id="<verb>"` heading.
const guideLabels = ['Syntax', 'Arguments', 'What it does', 'What it writes', 'Example'];

function articleHtml(file) {
  const html = readFileSync(file, 'utf8');
  const marker = html.indexOf('sl-markdown-content');
  if (marker === -1) {
    return '';
  }
  // Walk the <div> nesting from the wrapper's open tag to its matching close,
  // so the last verb's slice ends where the article content ends.
  const start = html.lastIndexOf('<div', marker);
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) {
      return html.slice(start, m.index);
    }
  }
  return html.slice(start);
}

function normalizeHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x3C;/gi, '<')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalized text of every table row of a built page (same-row assertions).
function tableRows(file) {
  const html = readFileSync(file, 'utf8');
  return (html.match(/<tr\b[\s\S]*?<\/tr>/g) || []).map(normalizeHtml);
}

const idsOnPage = new Map();
for (const [cluster, verbs] of Object.entries(commandClusters)) {
  const file = docsPage('commands', cluster);
  const label = `docs/commands/${cluster}`;
  if (!existsSync(file)) {
    continue;
  }
  const text = normalizedText(file);
  const article = articleHtml(file);
  idsOnPage.set(cluster, new Set([...readFileSync(file, 'utf8').matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
  for (const verb of verbs) {
    if (!text.includes(`/trailhead:${verb}`)) {
      failures.push(`${label} missing verb: /trailhead:${verb}`);
    }
  }
  // "On this page": every verb heading is listed in the TOC (outside the article).
  const outsideArticle = readFileSync(file, 'utf8').replace(article, '');
  for (const verb of verbs) {
    if (!outsideArticle.includes(`href="#${verb}"`)) {
      failures.push(`${label}: "On this page" TOC does not list #${verb}`);
    }
  }
  const headings = verbs.map((verb) => ({ verb, at: article.indexOf(`<h3 id="${verb}"`) }));
  headings.forEach(({ verb, at }, i) => {
    if (at === -1) {
      failures.push(`${label}: no <h3 id="${verb}"> heading in the article body`);
      return;
    }
    const nextAt = headings.slice(i + 1).map((h) => h.at).find((x) => x > at);
    const section = article.slice(at, nextAt === undefined ? undefined : nextAt);
    // The bold labels, in this exact order, inside this verb's own section.
    let previousAt = -1;
    for (const guideLabel of guideLabels) {
      const labelAt = section.indexOf(`<strong>${guideLabel}</strong>`);
      if (labelAt === -1) {
        failures.push(`${label} #${verb}: section missing bold "${guideLabel}"`);
      } else if (labelAt < previousAt) {
        failures.push(`${label} #${verb}: "${guideLabel}" is out of order`);
      } else {
        previousAt = labelAt;
      }
    }
  });
}

// Every verb on the index links to /docs/commands/<cluster>#<verb>, and the
// anchor resolves to an id actually built on the target page.
if (existsSync(commandsIndex)) {
  const indexHtml = readFileSync(commandsIndex, 'utf8');
  for (const [cluster, verbs] of Object.entries(commandClusters)) {
    for (const verb of verbs) {
      const href = `/docs/commands/${cluster}#${verb}`;
      if (!indexHtml.includes(`href="${href}"`)) {
        failures.push(`docs/commands index missing link: ${href}`);
      }
      const ids = idsOnPage.get(cluster);
      if (ids && !ids.has(verb)) {
        failures.push(`docs/commands/${cluster} has no id="${verb}" for the index link`);
      }
    }
  }
}

// Configuration page semantics (#196): tiers, profiles, Codex defaults and the
// pinned model review, asserted on table rows rather than loose keywords.
const configurationIndex = docsPage('configuration');
if (existsSync(configurationIndex)) {
  const rows = tableRows(configurationIndex);
  const hasRow = (pattern) => rows.some((row) => pattern.test(row));
  const tierRows = [
    ['strong', 'claude-opus-5-5', 'gpt-5\\.6-sol', 'high'],
    ['standard', 'claude-sonnet-5-5', 'gpt-5\\.6-terra', 'medium'],
    ['fast', 'claude-haiku-5-5', 'gpt-5\\.6-luna', 'low'],
  ];
  for (const [tier, claude, codex, effort] of tierRows) {
    if (!hasRow(new RegExp(`^${tier} .*${claude}.*${codex}.*\\b${effort}\\b`))) {
      failures.push(`docs/configuration: no tier row pairing ${tier} with ${claude}, ${codex}, ${effort}`);
    }
  }
  const profileRows = {
    High: /^High strong strong standard strong strong strong standard$/,
    Balanced: /^Balanced( \(default\))? strong standard standard standard standard standard fast$/,
    Low: /^Low standard standard fast fast standard fast fast$/,
  };
  for (const [name, pattern] of Object.entries(profileRows)) {
    if (!hasRow(pattern)) {
      failures.push(`docs/configuration: profile row for ${name} missing or wrong tiers`);
    }
  }
  if (!readFileSync(configurationIndex, 'utf8').includes('id="pinned-model-review"')) {
    failures.push('docs/configuration has no id="pinned-model-review" (anchor other pages link to)');
  }
  const text = normalizedText(configurationIndex);
  for (const needle of [
    'Manual',
    'inherit session',
    'model-defaults-ack',
    'models.codex',
    '/trailhead:config',
  ]) {
    if (!text.includes(needle)) {
      failures.push(`docs/configuration missing expected content: ${needle}`);
    }
  }
}

// Hooks page (#196): the commit-msg hook, the session-start update check, and
// the Codex mockup-link twin; teamwork links to the commit-msg section.
const hooksIndex = docsPage('hooks');
if (existsSync(hooksIndex)) {
  const text = normalizedText(hooksIndex);
  for (const needle of [
    'mockup-link-stop',
    'Refs: #<n>',
    'core.hooksPath',
    'model-defaults-ack',
  ]) {
    if (!text.includes(needle)) {
      failures.push(`docs/hooks missing expected content: ${needle}`);
    }
  }
  const hooksHtml = readFileSync(hooksIndex, 'utf8');
  for (const id of ['commit-msg-hook', 'session-start-update-check']) {
    if (!hooksHtml.includes(`id="${id}"`)) {
      failures.push(`docs/hooks has no id="${id}" (anchor other pages link to)`);
    }
  }
}
const teamworkIndex = docsPage('teamwork');
if (existsSync(teamworkIndex)) {
  if (!readFileSync(teamworkIndex, 'utf8').includes('href="/docs/hooks#commit-msg-hook"')) {
    failures.push('docs/teamwork does not link to /docs/hooks#commit-msg-hook');
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

for (const { file, expectedKey: key } of heroRoutes) {
  if (!existsSync(file)) {
    failures.push(
      `docs hero (${key}): missing expected build output: ${path.relative(siteRoot, file)}`
    );
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
  // real title, assert it self-hides via aria-hidden.
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

// #116: sitemap + robots.txt, present and pointing at the right domain.
// The origin is derived from the built sitemap-index.xml itself (not a
// literal hardcoded here) so this assertion can never silently pass against
// the wrong domain if astro.config.mjs's `site` ever changes.
const sitemapIndex = path.join(dist, 'sitemap-index.xml');
let siteOrigin;
if (!existsSync(sitemapIndex)) {
  failures.push(`missing expected build output: ${path.relative(siteRoot, sitemapIndex)}`);
} else {
  const sitemapText = readFileSync(sitemapIndex, 'utf8');
  const locMatch = sitemapText.match(/<loc>(https?:\/\/[^/]+)\/[^<]*<\/loc>/);
  if (!locMatch) {
    failures.push('sitemap-index.xml has no <loc> entry to derive the site origin from');
  } else {
    siteOrigin = locMatch[1];
  }
}

if (siteOrigin) {
  const robotsTxt = path.join(dist, 'robots.txt');
  const robotsSitemapLine = `Sitemap: ${siteOrigin}/sitemap-index.xml`;
  if (!existsSync(robotsTxt)) {
    failures.push(`missing expected build output: ${path.relative(siteRoot, robotsTxt)}`);
  } else {
    const robotsText = readFileSync(robotsTxt, 'utf8');
    if (!robotsText.includes(robotsSitemapLine)) {
      failures.push(`robots.txt missing expected line: ${robotsSitemapLine}`);
    }
  }
}

// #116: every page's og:image must point at a PNG that was actually built.
// Walk the whole dist/ tree (not just the known routes above) so a future
// page that forgets to wire up its social-card image fails loudly here.
function findHtmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return findHtmlFiles(full);
    }
    return name.endsWith('.html') ? [full] : [];
  });
}

const ogImageIndex = path.join(dist, 'og', 'index.png');
if (!existsSync(ogImageIndex)) {
  failures.push(`missing expected build output: ${path.relative(siteRoot, ogImageIndex)}`);
}

if (existsSync(dist) && siteOrigin) {
  const ogImagePattern = /<meta\s+property="og:image"\s+content="([^"]+)"/;
  for (const htmlFile of findHtmlFiles(dist)) {
    const label = path.relative(siteRoot, htmlFile);
    const html = readFileSync(htmlFile, 'utf8');
    const match = html.match(ogImagePattern);
    if (!match) {
      failures.push(`${label} missing an og:image meta tag`);
      continue;
    }
    const ogImageUrl = match[1];
    if (!ogImageUrl.startsWith(`${siteOrigin}/`)) {
      failures.push(`${label} has an og:image not rooted at ${siteOrigin}: ${ogImageUrl}`);
      continue;
    }
    const ogImageLocalPath = path.join(dist, ogImageUrl.slice(siteOrigin.length));
    if (!existsSync(ogImageLocalPath)) {
      failures.push(
        `${label} references og:image ${ogImageUrl}, but ${path.relative(siteRoot, ogImageLocalPath)} was not built`
      );
    }
  }
}

if (existsSync(landingIndex)) {
  const landingHtml = readFileSync(landingIndex, 'utf8');
  if (!landingHtml.includes('rel="canonical"')) {
    failures.push('landing (dist/index.html) missing rel="canonical"');
  }
  if (!landingHtml.includes('twitter:card')) {
    failures.push('landing (dist/index.html) missing twitter:card meta');
  }
}

// #117: assert the beacon renders as exactly one coherent <script> tag on
// every published route, order-independent among the head's other scripts.
// Raw HTML (not normalizedText(), which strips tags) so the `<script ...>`
// open tags themselves are still there to match against.
const beaconRoutes = [
  { label: path.relative(siteRoot, landingIndex), file: landingIndex },
  { label: path.relative(siteRoot, docsBrandIndex), file: docsBrandIndex },
  ...docsSlugs.map((slug) => {
    const file = path.join(dist, 'docs', slug, 'index.html');
    return { label: path.relative(siteRoot, file), file };
  }),
  { label: path.relative(siteRoot, notFoundIndex), file: notFoundIndex },
];

for (const { label, file } of beaconRoutes) {
  if (!existsSync(file)) {
    continue;
  }
  const html = readFileSync(file, 'utf8');
  const scriptOpenTags = html.match(/<script\b[^>]*>/gi) || [];
  const beaconTags = scriptOpenTags.filter((tag) => tag.includes(cfBeaconSrc));
  if (beaconTags.length !== 1) {
    failures.push(
      `${label}: expected exactly one Cloudflare Web Analytics beacon <script>, found ${beaconTags.length}`
    );
  } else if (!beaconTags[0].includes(cfBeaconToken)) {
    failures.push(`${label}: beacon <script> present but missing/mismatched token ${cfBeaconToken}`);
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
  'check-routes: OK: landing and all 15 /docs/* pages resolved, every verb guide section complete, config/hooks semantics asserted, no /en prefix, install/verb facts present, no placeholder copy left, all 15 per-page hero markers present (full-width banner below the title, aria-hidden), sitemap/robots.txt present, every page\'s og:image resolves to a built PNG, and the Cloudflare Web Analytics beacon is asserted on every route (landing, all 15 /docs/* pages, and 404).'
);
process.exit(0);
