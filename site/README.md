# trailhead site

This `site/` subtree is the trailhead website: a placeholder landing page at
`/` plus a Starlight-powered docs skeleton at `/docs/`. It is excluded from
the npm package by the root `files` whitelist in the repo's top-level
`package.json` — it ships only as source in the git repo, never as part of
the published `@marcomigozzi/trailhead` package.

## Deployment

Cloudflare Pages builds this subtree directly:

- **Root directory**: `site`
- **Build command**: `npm run build`
- **Output directory**: `dist`

Node must be an **even** major version `>= 22.12.0` (odd majors like 23 or
25 are unsupported by Astro). The pinned version lives in `.node-version`
and Cloudflare Pages honors it automatically.

## Scripts

```sh
npm install     # install dependencies
npm run dev     # local dev server
npm run build   # static build -> dist/
npm run preview # preview the built output
npm run check   # assert the build output routes are correct
```

## Status

This is a skeleton scaffold (see ticket #103): the landing page and docs
content are placeholders. Real landing design, docs content, the custom
domain, SEO, analytics, and CI are tracked separately and out of scope here.
