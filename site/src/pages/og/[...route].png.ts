// Build-time OpenGraph/Twitter social-card images (#116), one PNG per
// registered page (see src/lib/og-pages.ts). Card is a dark, on-brand
// look built from the same palette as the landing/docs UI:
// background #0a0f0d, orange accent #f3844f, cream title #f2efe8, muted
// description #9fb0a6.
//
// The route filename already carries the literal `.png` suffix (Astro
// endpoint convention: `[...route].png.ts` -> URL `/og/<route>.png`), so
// `getSlug` must return the bare path with no extension — the library's
// default `getSlug` also appends `.png`, which would double it up here.
import { OGImageRoute } from 'astro-og-canvas';
import { getOgPages } from '../../lib/og-pages';

const pages = await getOgPages();

// Vendored Noto Sans (regular + bold), both under the embedded family name
// "Noto Sans" (#116): astro-og-canvas otherwise fetches this same face from
// api.fontsource.org on every build. Bundling it locally keeps the build
// hermetic and self-hosted, with no network dependency.
const notoSansRegular = './src/assets/fonts/noto-sans-latin-400-normal.ttf';
const notoSansBold = './src/assets/fonts/noto-sans-latin-700-normal.ttf';

export const { getStaticPaths, GET } = await OGImageRoute({
  pages,
  getSlug: (path) => path,
  getImageOptions: (key, page) => ({
    title: page.title,
    description: page.description,
    bgGradient: [[10, 15, 13]],
    border: { color: [243, 132, 79], width: 8, side: 'inline-start' },
    padding: 64,
    // The docs cards carry only the page title, so brand them with the
    // trailhead wordmark at the top (#116). The landing card's title is
    // already "trailhead", so it needs no logo.
    ...(key === 'index'
      ? {}
      : { logo: { path: './src/assets/trailhead-wordmark.png', size: [200] } }),
    fonts: [notoSansRegular, notoSansBold],
    font: {
      title: { color: [242, 239, 232], size: 68, weight: 'Bold', families: ['Noto Sans'] },
      description: { color: [159, 176, 166], size: 34, families: ['Noto Sans'] },
    },
  }),
});
