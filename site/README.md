# trailhead site

This `site/` subtree is the trailhead website: the landing page at
`/` plus the Starlight-powered docs at `/docs/`. It is excluded from
the npm package by the root `files` whitelist in the repo's top-level
`package.json`: it ships only as source in the git repo, never as part of
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
npm run check   # build, then assert the output routes are correct
npm run check:routes # assert routes against the current dist/ (no rebuild)
```

`npm run check` builds first, so it never passes against a stale `dist/`.

## Status

The landing page and docs content are real and live here. Site CI
(`.github/workflows/site-ci.yml`) builds the site, checks the output routes
and runs a dead-link check on pull requests and pushes that touch `site/**`.
It does not deploy: Cloudflare Pages deploys on push to main.
