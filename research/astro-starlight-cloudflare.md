# Astro + Starlight on Cloudflare Pages: Decision Reference

## Executive Summary

For a static Astro project with a custom landing at `/` and Starlight docs at `/docs` on Cloudflare Pages:
- **Project structure**: Single Astro project with `src/pages/index.astro` (landing) and `src/content/docs/` (Starlight)
- **Critical design choice**: Starlight's default configuration creates URL routes directly from content structure. Mounting docs at `/docs` path requires either mounting the entire site at `/docs` (Astro's `base` config) or using Starlight's i18n/locale routing as a workaround
- **Recommended approach**: Colocate landing and docs in one project; use directory structure `src/content/docs/` which creates URLs like `/introduction`, `/guide/` etc., with a custom index at `/` via `src/pages/index.astro`
- **Cloudflare Pages**: Build command `npm run build`, output `dist`, Node ≥22.12.0, frame set via dashboard
- **Confidence**: HIGH for build config and coexistence pattern (official docs + deployment guide); MEDIUM for `/docs` mounting (requires architectural choice, not a single official recommendation)

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

### File Organization Example

```
src/
├── pages/
│   └── index.astro                    # Custom landing at /
├── content/
│   └── docs/
│       ├── index.md                   # Docs homepage at /docs/ (with proper config)
│       ├── installation.md            # At /docs/installation or /installation depending on config
│       ├── guides/
│       │   └── routing.md             # At /docs/guides/routing or /guides/routing
│       └── reference/
│           └── config.md              # At /docs/reference/config or /reference/config
├── components/
├── layouts/
└── styles/
```

### The `/docs` Path Challenge

**Critical finding**: Starlight uses file-based routing from `src/content/docs/` content collection. By default, a file at `src/content/docs/introduction.md` creates a route at `/introduction`, NOT `/docs/introduction`. This is the core architectural constraint.

**Three approaches to serve Starlight at `/docs` path:**

#### Option A: Mount Entire Site at `/docs` (Not recommended for this use case)
Set Astro's `base` config:
```javascript
// astro.config.mjs
export default defineConfig({
  base: '/docs',
  integrations: [starlight({ title: 'Docs' })],
});
```
**Problem**: This moves BOTH the landing page and docs to `/docs/`, so landing becomes `/docs/` instead of `/`.
**Source**: [Astro Configuration Reference - base](https://docs.astro.build/en/reference/configuration-reference/) documents that `base` "allows you to deploy to a sub-directory by specifying a path prefix" and affects the entire site.

#### Option B: Use Locale/i18n Routing (Workaround)
Starlight supports locale-based URL prefixes via `locales` configuration:
```javascript
// astro.config.mjs
export default defineConfig({
  integrations: [
    starlight({
      title: 'Docs',
      locales: {
        root: {
          label: 'Docs',
          lang: 'en',
        },
      },
    }),
  ],
});
```
**How it works**: Configure `root` locale and place docs in `src/content/docs/` root. This keeps docs at `/` and landing in `src/pages/index.astro`.
**Problem**: Not a primary use case; i18n routing is designed for language support, not site sections.
**Source**: [Starlight Internationalization Guide](https://starlight.astro.build/guides/i18n/) explains locale routing structure.

#### Option C: Separate Projects or Reverse Proxy (Alternative architecture)
- Deploy landing as a static site on Cloudflare Pages at `trailhead.marcomigozzi.it/`
- Deploy Starlight separately on another Pages project and map `/docs/` via Cloudflare Workers reverse proxy
**Complexity**: Requires two repositories or shared publishing pipeline.

#### **Recommended**: Option A (site-wide `base: '/docs'`)
If the business goal is to eventually move the entire site to a `/docs` path (e.g., trailhead.marcomigozzi.it**/docs**/), use Astro's `base: '/docs'` and adjust the landing page URL expectation. This is the cleanest from Starlight's perspective, as it respects the framework's routing model.

**If landing must stay at `/`**: Accept that Starlight docs will be at root URLs (e.g., `/introduction`, `/guides/routing`) and use a custom header or navigation to establish a conceptual "/docs section" for UX.

**Confidence**: MEDIUM - Coexistence is documented; mounting at a specific path is an architectural choice not explicitly recommended in official docs.

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

- [ ] **Project structure**: Create landing at `src/pages/index.astro`, Starlight docs at `src/content/docs/`
- [ ] **Astro config**: Add Starlight integration; decide on `base` path (recommend `/docs` if site will live at `/docs`, or omit if landing stays at `/`)
- [ ] **Build locally**: Run `npm run build` and verify `dist/` output
- [ ] **Cloudflare Pages**: Connect GitHub repo, set framework to Astro, confirm `npm run build` → `dist`
- [ ] **Production branch**: Set to `main`; enable automatic deployments
- [ ] **Custom domain**: Add `trailhead.marcomigozzi.it` via Pages dashboard → Custom domains
- [ ] **DNS (if needed)**: Verify CNAME record `trailhead` → `trailhead.pages.dev` in Cloudflare zone
- [ ] **Preview deployments**: Confirm PR preview URLs work (should be automatic)
- [ ] **Test**: Visit `https://trailhead.marcomigozzi.it/`, verify landing page; check `/introduction`, `/guides/` for docs
- [ ] **Node version pinning** (optional): Add `node_version = "22.12.0"` to `wrangler.toml` or set `NODE_VERSION` env var in Cloudflare dashboard

---

## Key Decisions & Tradeoffs

| Decision | Tradeoff | Recommendation |
|----------|----------|-----------------|
| **Mount Starlight at `/docs` path?** | Requires mounting entire site at `/docs`, moving landing to `/docs/`. Clean for Starlight; breaks "/" expectation for landing. | Accept landing + docs at root URLs; use navigation/branding to signal "docs section". OR plan to migrate landing to `/docs/` in future. |
| **Single project vs. two projects?** | One project is simpler to maintain; two projects isolates concerns but requires separate deploys. | Use single project (Astro + Starlight coexistence is supported). |
| **Node version pinning?** | Explicit pinning (22.12.0) ensures reproducibility; Cloudflare's LTS default is usually safe. | Let Cloudflare use LTS; pin only if you have a specific version requirement. |
| **Preview vs. production branch strategy?** | All non-production branches is the safest default; custom patterns give fine control but risk human error. | Start with "All non-production branches"; add custom patterns if automation (Dependabot) creates noise. |

---

## Sources & Confidence

| Topic | Primary Source | Confidence |
|-------|---|---|
| Astro + Starlight coexistence | Starlight Manual Setup + Astro routing docs | HIGH |
| Starlight at `/docs` path | Astro `base` config + i18n routing docs | MEDIUM (no single "recommended" path) |
| Cloudflare Pages Astro build config | Official Cloudflare Pages Astro guide | HIGH |
| Node.js version | Astro installation docs | HIGH |
| Preview deployments & branch control | Cloudflare Pages docs | HIGH |
| Custom domain setup | Cloudflare Pages custom domains guide | HIGH |
| Root directory / monorepo | Cloudflare Pages configuration docs | HIGH |

---

## References

- [Starlight Getting Started](https://starlight.astro.build/getting-started/)
- [Starlight Manual Setup](https://starlight.astro.build/manual-setup/)
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
