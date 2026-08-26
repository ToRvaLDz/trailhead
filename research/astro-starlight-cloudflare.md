# Astro + Starlight on Cloudflare Pages: Decision Reference

## Executive Summary

For a static Astro project with a custom landing at `/` and Starlight docs at `/docs` on Cloudflare Pages:
- **Project structure**: Single Astro project with `src/pages/index.astro` (landing) and `src/content/docs/` (Starlight)
- **Critical design choice**: Starlight derives doc URLs from file paths inside the `src/content/docs/` content collection. To serve docs under `/docs/` while keeping `/` for a custom landing, **nest all doc content in a `docs/` subdirectory** of the collection (`src/content/docs/docs/…`). This is the officially documented subpath pattern; Starlight has no native `base`/`routePrefix` option.
- **Recommended approach**: One project. Custom landing at `src/pages/index.astro` → `/`; Starlight content under `src/content/docs/docs/` → `/docs/…`. Sidebar `autogenerate: { directory: 'docs' }` builds the docs nav automatically.
- **Cloudflare Pages**: Build command `npm run build`, output `dist`, Node ≥22.12.0, framework preset Astro.
- **Confidence**: HIGH across the board, including `/docs` mounting (the nesting pattern is documented in Starlight's Pages guide and works with static output on Cloudflare Pages).

---

## 1. Project Structure: Custom Landing + Starlight Docs in One Project

### Architectural Pattern

You can coexist a custom landing page and Starlight documentation in a single Astro project:

| Component | Location | Result |
|-----------|----------|--------|
| Custom landing page | `src/pages/index.astro` | Serves at `/` |
| Starlight docs | `src/content/docs/` | Content collection; files route to URLs based on filename hierarchy |
| Starlight config | `astro.config.mjs` | Integrates Starlight as an Astro integration |

**Source**: [Starlight Manual Setup Guide](https://starlight.astro.build/manual-setup/) confirms that Starlight can be integrated into an existing Astro project alongside custom pages. [Astro Project Structure](https://docs.astro.build/en/basics/project-structure/) documents that `src/pages/` is the only reserved directory, allowing Starlight to use `src/content/docs/` without conflict.

### File Organization Example (landing at `/`, docs at `/docs/`)

```
src/
├── pages/
│   └── index.astro                    # Custom landing at /
├── content/
│   └── docs/
│       └── docs/                       # nest all Starlight content one level down
│           ├── index.md               # → /docs/
│           ├── installation.md        # → /docs/installation
│           ├── guides/
│           │   └── routing.md         # → /docs/guides/routing
│           └── reference/
│               └── config.md          # → /docs/reference/config
├── content.config.ts                   # docs collection schema (docsSchema())
├── components/
├── layouts/
└── styles/
```

### The `/docs` Path: the supported way

**Key fact**: Starlight uses file-based routing from the `src/content/docs/` content collection. A file's URL is derived from its **path inside** that collection: `src/content/docs/introduction.md` → `/introduction`. So to put every doc under `/docs/`, **nest the whole docs tree one level deeper**, in `src/content/docs/docs/`: `src/content/docs/docs/index.md` → `/docs/`, `src/content/docs/docs/installation.md` → `/docs/installation`, and so on. The root `/` stays free for a custom `src/pages/index.astro`.

This is not a hack: Starlight's own Pages guide documents adding all pages at a subpath by placing the content inside a subdirectory of `src/content/docs/`. `src/pages/` and the Starlight content collection coexist (only `src/pages/` is Astro-reserved), so the custom landing and the docs live in one project.

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  output: 'static',                       // static build for Cloudflare Pages
  integrations: [
    starlight({
      title: 'trailhead',
      sidebar: [
        // autogenerate reads from src/content/docs/docs/
        { label: 'Docs', autogenerate: { directory: 'docs' } },
      ],
    }),
  ],
});
```

```typescript
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ schema: docsSchema() }),
};
```

**Why this over the alternatives:**
- **Astro site-wide `base: '/docs'`** moves the *entire* site (landing included) under `/docs/`, so the landing is no longer at `/`. Wrong for this use case.
- **Starlight has no native `base`/`routePrefix` config option.** A prefix option is an open feature request ([discussion #966](https://github.com/withastro/starlight/discussions/966)), not shipped. The nested-subdirectory layout is the officially documented workaround.

**Sidebar & links**: `autogenerate: { directory: 'docs' }` turns the nested folders into sidebar groups automatically; internal links and slugs derive from the file paths, so they already carry the `/docs/` prefix. One gotcha: do not also create a page at `/docs/` from `src/pages/` (e.g. `src/pages/docs.astro`), or it collides with the collection route.

**Sources**: [Starlight Pages Guide](https://starlight.astro.build/guides/pages/) (subpath via subdirectory; coexistence with `src/pages/`), [Starlight Sidebar Guide](https://starlight.astro.build/guides/sidebar/) (`autogenerate` groups), [Starlight Configuration Reference](https://starlight.astro.build/reference/configuration/) (no native base/prefix option), [Starlight discussion #966](https://github.com/withastro/starlight/discussions/966) (prefix is an unshipped request).

**Confidence**: HIGH - the nesting pattern is documented in Starlight's Pages guide, the absence of a native prefix option is verified against the full config reference, and static output is supported on Cloudflare Pages.

---

## 2. Cloudflare Pages Build Settings for Static Astro Site

### Exact Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| **Build Command** | `npm run build` | Standard Astro build. Uses `astro build` under the hood defined in `package.json` scripts. |
| **Build Directory** | `dist` | Astro's default output directory per `astro.config.mjs` (configurable via `outDir` if needed). |
| **Framework Preset** | **Astro** | Select from Cloudflare dashboard dropdown; auto-fills above values. |
| **Node.js Version** | 22.12.0 or higher (even versions only) | Astro requires even-numbered Node versions. Odd versions (v23, v25) are not supported. |
| **Output Directory (outDir)** | `dist` | Astro config default; do not change unless project specifies otherwise. |

**Sources**:
- [Cloudflare Pages — Deploy an Astro Site](https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/): Confirms `npm run build` → `dist`, production branch `main`
- [Astro Installation Guide](https://docs.astro.build/en/install/auto/): Specifies "Node.js `v22.12.0` or higher. Odd-numbered versions like `v23` are not supported."
- [Cloudflare Pages Build Configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/): Explains build command exit codes, framework presets, and environment variables.

### Dashboard Setup Steps

1. Go to Cloudflare Dashboard → **Workers & Pages**
2. Select **Pages** → **Create application** → **Connect to Git**
3. Authorize GitHub and select the `ToRvaLDz/trailhead` repository
4. Under "Build settings":
   - Framework preset: **Astro** (auto-fills build command and directory)
   - Or manually enter:
     - Build command: `npm run build`
     - Build output directory: `dist`
5. Under "Environment":
   - Cloudflare automatically injects: `CI=true`, `CF_PAGES=1`, `CF_PAGES_COMMIT_SHA`, `CF_PAGES_BRANCH`, `CF_PAGES_URL`
   - Add custom env vars if needed (e.g., `NODE_VERSION=22.12.0` for explicit pinning, though Cloudflare defaults to a recent LTS)
6. Click **Save and Deploy**

**Confidence**: HIGH - Official Cloudflare Pages Astro guide provides exact settings.

---

## 3. Per-PR Preview Deployments and Production Branch Mapping

### Preview Deployments (Automatic)

When you connect a GitHub repository to Cloudflare Pages:

- **Default behavior**: Every commit to every branch (except production branch) triggers a preview deployment
- **Preview URL formats**:
  - Hash-based (permanent): `<random-hash>.<project>.pages.dev` (e.g., `373f31e2.trailhead.pages.dev`)
  - Branch alias (latest commit): `<branch-name>.<project>.pages.dev` (e.g., `feature-branch.trailhead.pages.dev`)
- **Pull requests**: Automatic preview URL generated in PR checks; updates with new commits
- **SEO**: All preview deployments auto-include `X-Robots-Tag: noindex` header (protected from search indexing)
- **Access control** (optional): Enable Cloudflare Access to restrict preview visibility

**Source**: [Cloudflare Pages — Preview Deployments](https://developers.cloudflare.com/pages/platform/preview-deployments/): Explains hash-based and branch-alias URLs, automatic PR integration, and SEO headers.

### Production Branch Configuration

1. Go to Cloudflare Pages project → **Settings** → **Builds & deployments**
2. Under "Production deployments":
   - **Production branch**: Default is `main`; can change to `master`, `production`, etc.
   - **Enable automatic production branch deployments**: Toggle ON (default) to deploy on each push to production branch

### Branch Build Controls

Fine-grained control over which branches deploy:

| Strategy | Configuration |
|----------|----------------|
| **All non-production branches** | Default; every branch except production previews |
| **None** | Disable preview builds entirely; production only |
| **Custom branches** | Specify patterns with wildcards: `feat/*, fix/*, chore/*` |

**Pattern syntax**:
- `*` matches zero or more characters
- Rules process in order: excludes first, then includes
- Example: `Include: *` + `Exclude: dependabot/*` allows all except Dependabot bot branches

**Example for trailhead**:
```
Production branch: main
Preview branches strategy: All non-production branches
Custom includes (optional): feature/*, fix/*, research/*
Custom excludes (optional): dependabot/*, auto/*
```

**Source**: [Cloudflare Pages — Branch Build Controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/): Explains all three strategies, wildcard syntax, and rule ordering.

**Confidence**: HIGH - Official Cloudflare Pages documentation is authoritative.

---

## 4. Binding Custom Subdomain via Cloudflare DNS

### Setup Steps

1. **Prerequisite**: Your domain must use Cloudflare's nameservers (or you manage a Cloudflare zone for it)
   - For `marcomigozzi.it`: Confirm it's already a Cloudflare zone or add it

2. **Dashboard navigation**:
   - Go to **Workers & Pages** → Select your `trailhead` Pages project
   - Go to **Settings** → **Custom domains**
   - Click **Set up a domain**

3. **Add subdomain**:
   - Enter: `trailhead.marcomigozzi.it`
   - Cloudflare validates DNS configuration
   - If your domain is a Cloudflare zone, it auto-creates the CNAME record

4. **DNS Record** (if not auto-created):
   - Type: **CNAME**
   - Name: `trailhead` (or full `trailhead.marcomigozzi.it` depending on your DNS provider UI)
   - Value: `<project-name>.pages.dev` (e.g., `trailhead.pages.dev`)
   - TTL: Auto (or 3600)

### Critical Requirement

**Important**: You MUST add the domain via Cloudflare dashboard FIRST, then create the DNS record. "Manually adding a CNAME record pointing to your Cloudflare Pages site without first associating the domain in the dashboard will result in your domain failing to resolve."

**Source**: [Cloudflare Pages — Custom Domains](https://developers.cloudflare.com/pages/configuration/custom-domains/): States dashboard-first requirement and CNAME setup instructions.

### SSL/TLS

- Cloudflare automatically provisions SSL certificates for your custom domain
- No manual certificate management needed
- Certificates auto-renew

**Confidence**: HIGH - Official Cloudflare Pages custom domain documentation.

---

## 5. Building from a Subdirectory (Monorepo / `site/` subtree)

### Cloudflare Pages Root Directory Setting

If your Astro project lives in a subdirectory of the repository (e.g., `/site/`):

1. In Cloudflare Dashboard → Pages project → **Settings** → **Builds & deployments**
2. Under "Build settings":
   - **Root directory** (or "Project directory"): Enter `site`
   - Cloudflare will run the build from that directory root

### Example Repository Structure

```
repository-root/
├── .git/
├── package.json                    # (mono-root, if monorepo)
├── site/                           # ← Astro project here
│   ├── astro.config.mjs
│   ├── package.json
│   ├── src/
│   ├── public/
│   └── dist/                       # Build output
├── docs/                           # (another project)
└── scripts/                        # (utilities)
```

**Cloudflare Pages configuration**:
- Root directory: `site`
- Build command: `npm run build` (runs in `site/` directory)
- Build output directory: `dist` (relative to `site/`)

### Alternative: Build from Repository Root with Custom Build Command

If you want to stay flexible, you can also:
1. Keep root directory blank (defaults to repository root)
2. Use a build script that explicitly navigates: `cd site && npm run build`

**Tradeoff**: Less clear than explicit root directory setting, but more control.

**Source**: [Cloudflare Pages — Build Configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/): Explains root directory for monorepos. [Cloudflare Pages — Configuration Index](https://developers.cloudflare.com/pages/configuration/): References monorepo support.

**Confidence**: HIGH - Cloudflare's monorepo / root directory feature is well-documented.

---

## Implementation Checklist for trailhead.marcomigozzi.it

- [ ] **Project structure**: Landing at `src/pages/index.astro`; nest all Starlight content under `src/content/docs/docs/` so it serves at `/docs/…`
- [ ] **Astro config**: Add Starlight integration with `output: 'static'` and `sidebar: [{ autogenerate: { directory: 'docs' } }]`; define the `docs` collection with `docsSchema()` in `src/content.config.ts`
- [ ] **Build locally**: Run `npm run build` and verify `dist/` output
- [ ] **Cloudflare Pages**: Connect GitHub repo, set framework to Astro, confirm `npm run build` → `dist`
- [ ] **Production branch**: Set to `main`; enable automatic deployments
- [ ] **Custom domain**: Add `trailhead.marcomigozzi.it` via Pages dashboard → Custom domains
- [ ] **DNS (if needed)**: Verify CNAME record `trailhead` → `trailhead.pages.dev` in Cloudflare zone
- [ ] **Preview deployments**: Confirm PR preview URLs work (should be automatic)
- [ ] **Test**: Visit `https://trailhead.marcomigozzi.it/`, verify landing page; check `/docs/`, `/docs/guides/…` for docs
- [ ] **Node version pinning** (optional): Add `node_version = "22.12.0"` to `wrangler.toml` or set `NODE_VERSION` env var in Cloudflare dashboard

---

## Key Decisions & Tradeoffs

| Decision | Tradeoff | Recommendation |
|----------|----------|-----------------|
| **Mount Starlight at `/docs` path?** | Site-wide `base: '/docs'` also moves the landing; Starlight has no native prefix option. | Nest all docs under `src/content/docs/docs/` (documented subpath pattern): landing stays at `/`, docs at `/docs/…`. |
| **Single project vs. two projects?** | One project is simpler to maintain; two projects isolates concerns but requires separate deploys. | Use single project (Astro + Starlight coexistence is supported). |
| **Node version pinning?** | Explicit pinning (22.12.0) ensures reproducibility; Cloudflare's LTS default is usually safe. | Let Cloudflare use LTS; pin only if you have a specific version requirement. |
| **Preview vs. production branch strategy?** | All non-production branches is the safest default; custom patterns give fine control but risk human error. | Start with "All non-production branches"; add custom patterns if automation (Dependabot) creates noise. |

---

## Sources & Confidence

| Topic | Primary Source | Confidence |
|-------|---|---|
| Astro + Starlight coexistence | Starlight Manual Setup + Astro routing docs | HIGH |
| Starlight at `/docs` path (nested subdirectory) | Starlight Pages guide + Configuration reference (no native prefix) | HIGH |
| Cloudflare Pages Astro build config | Official Cloudflare Pages Astro guide | HIGH |
| Node.js version | Astro installation docs | HIGH |
| Preview deployments & branch control | Cloudflare Pages docs | HIGH |
| Custom domain setup | Cloudflare Pages custom domains guide | HIGH |
| Root directory / monorepo | Cloudflare Pages configuration docs | HIGH |

---

## References

- [Starlight Getting Started](https://starlight.astro.build/getting-started/)
- [Starlight Manual Setup](https://starlight.astro.build/manual-setup/)
- [Starlight Pages Guide (subpath via subdirectory)](https://starlight.astro.build/guides/pages/)
- [Starlight Sidebar Guide (autogenerate)](https://starlight.astro.build/guides/sidebar/)
- [Starlight Configuration Reference](https://starlight.astro.build/reference/configuration/)
- [Starlight discussion #966 (route-prefix request, unshipped)](https://github.com/withastro/starlight/discussions/966)
- [Starlight Internationalization](https://starlight.astro.build/guides/i18n/)
- [Astro Project Structure](https://docs.astro.build/en/basics/project-structure/)
- [Astro Routing](https://docs.astro.build/en/basics/routing/)
- [Astro Configuration Reference - base](https://docs.astro.build/en/reference/configuration-reference/)
- [Astro Configuration Reference - outDir](https://docs.astro.build/en/reference/configuration-reference/)
- [Astro Installation (Node version)](https://docs.astro.build/en/install/auto/)
- [Cloudflare Pages — Deploy an Astro Site](https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/)
- [Cloudflare Pages — Build Configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Cloudflare Pages — Preview Deployments](https://developers.cloudflare.com/pages/platform/preview-deployments/)
- [Cloudflare Pages — Branch Build Controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)
- [Cloudflare Pages — Custom Domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Cloudflare Pages — Configuration Index](https://developers.cloudflare.com/pages/configuration/)
