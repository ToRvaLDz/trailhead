// Dynamic robots.txt (#116): derives the Sitemap origin from the configured
// `site` (astro.config.mjs) via the endpoint context instead of a static file
// with a hand-typed domain, so the two can never drift apart.
import type { APIContext } from 'astro';

export function GET(context: APIContext): Response {
  const sitemapUrl = new URL('/sitemap-index.xml', context.site);
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
