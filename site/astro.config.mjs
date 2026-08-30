import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

// Custom Expressive Code theme for the /docs/ code blocks, matching the
// landing page's `.code` treatment (see src/styles/landing.css): dim
// comments, orange keyword/tag accents, green string accents. Colors here
// are literal hex values rather than `var(--brand-token)` references —
// Expressive Code resolves theme colors at build time with a JS color
// library (for contrast checks, alpha blending, etc.) that cannot parse
// CSS custom properties, so brand CSS vars are only safe to use inside
// `styleOverrides` values that are passed through verbatim to the
// generated CSS (never through theme `colors`/`tokenColors`).
const trailheadCodeTheme = {
  name: 'trailhead-dark',
  type: 'dark',
  colors: {
    'editor.background': '#0a0f0d',
    'editor.foreground': '#f2efe8',
    'editor.selectionBackground': '#24322c',
    'terminal.background': '#0a0f0d',
    'terminal.foreground': '#f2efe8',
    'titleBar.activeBackground': '#0a0f0d',
    'titleBar.activeForeground': '#7d8f84',
    'titleBar.border': '#1c2823',
    'tab.activeBackground': '#0a0f0d',
    'tab.activeForeground': '#f2efe8',
    'tab.activeBorderTop': '#f3844f',
    'tab.activeBorder': '#0a0f0d00',
    'editorGroupHeader.tabsBackground': '#0a0f0d',
    'editorGroupHeader.tabsBorder': '#1c2823',
  },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: '#7d8f84', fontStyle: 'italic' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template'],
      settings: { foreground: '#4fae7c' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character'],
      settings: { foreground: '#f3844f' },
    },
    {
      scope: ['keyword', 'keyword.control', 'keyword.operator', 'storage', 'storage.type', 'storage.modifier'],
      settings: { foreground: '#f3844f' },
    },
    {
      scope: ['entity.name.function', 'support.function'],
      settings: { foreground: '#f2efe8' },
    },
    {
      scope: ['entity.name.tag', 'entity.name.type', 'entity.name.class', 'support.class'],
      settings: { foreground: '#4fae7c' },
    },
    {
      scope: ['entity.other.attribute-name'],
      settings: { foreground: '#f3844f' },
    },
    {
      scope: ['variable', 'variable.other', 'variable.parameter'],
      settings: { foreground: '#d7d9d2' },
    },
    {
      scope: ['punctuation'],
      settings: { foreground: '#9fb0a6' },
    },
  ],
};

export default defineConfig({
  output: 'static',
  site: 'https://trailhead.marcomigozzi.it',
  integrations: [
    starlight({
      title: 'trailhead',
      // Outbound links in the docs header: Starlight renders the `social`
      // option as icons next to the search box. Mirrors the landing nav's
      // GitHub + npm links (the wordmark already links back to the landing).
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ToRvaLDz/trailhead' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@marcomigozzi/trailhead' },
      ],
      // English served unprefixed at `/docs/`; a future locale would be
      // prefixed (e.g. `/it/docs/`) while `root` stays unprefixed.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
      },
      // Dark-only brand theme: custom SiteTitle reproduces the landing
      // wordmark and links home; ThemeSelect is emptied out to remove the
      // light/dark/auto picker (see src/components/DocsSiteTitle.astro and
      // EmptyThemeSelect.astro).
      components: {
        SiteTitle: './src/components/DocsSiteTitle.astro',
        ThemeSelect: './src/components/EmptyThemeSelect.astro',
        MarkdownContent: './src/components/docs/DocsMarkdownContent.astro',
        Head: './src/components/docs/Head.astro',
      },
      customCss: ['./src/styles/docs.css'],
      expressiveCode: {
        themes: [trailheadCodeTheme],
        styleOverrides: {
          borderRadius: '11px',
          borderColor: '#1c2823',
          codeBackground: '#0a0f0d',
          codeFontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", "Cascadia Code", monospace',
        },
      },
      head: [
        // Pin dark mode before paint. Belt-and-braces: the brand mapping in
        // docs.css already applies identical colors under :root,
        // [data-theme='light'], and [data-theme='dark'], so Starlight's own
        // inline theme-detection script (which still runs; only the picker
        // UI was removed) can never cause a visible flash either way.
        {
          tag: 'script',
          content: "document.documentElement.dataset.theme = 'dark';",
        },
        // Cloudflare Web Analytics beacon on every docs route (and 404), via the stock Head.
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: 'https://static.cloudflareinsights.com/beacon.min.js',
            'data-cf-beacon': '{"token": "9d745984ddba48329691930072aea137"}',
          },
        },
      ],
      sidebar: [
        {
          label: 'Docs',
          items: [
            { label: 'Overview', link: '/docs/' },
            { label: 'Getting started', link: '/docs/getting-started' },
            { label: 'Core concepts', link: '/docs/concepts' },
            { label: 'Workflow', link: '/docs/workflow' },
            { label: 'Ticket types', link: '/docs/ticket-types' },
            { label: 'Commands', link: '/docs/commands' },
            { label: 'Captures & the whiteboard', link: '/docs/captures' },
            { label: 'Working as a team', link: '/docs/teamwork' },
            { label: 'Configuration', link: '/docs/configuration' },
            { label: 'Hooks', link: '/docs/hooks' },
          ],
        },
      ],
    }),
    sitemap(),
  ],
});
