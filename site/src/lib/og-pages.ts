// Registry of pages that get a build-time OpenGraph/Twitter social-card
// image (#116). Keys MUST equal the Starlight route id the head overrides
// use to look images up: the docs index route's id is the bare "docs", every
// other docs page is "docs/<slug>" (empirically verified via a full `astro
// build`, same convention already relied on by src/components/docs/cards.ts).
//
// The landing page is the single hand-authored entry ("index"); every docs
// entry is derived from the `docs` content collection so a new docs page
// automatically gets a card with no registry edit required.
import { getCollection } from 'astro:content';

export interface OgPage {
  title: string;
  description: string;
}

const landingPage: OgPage = {
  title: 'trailhead',
  description:
    'Start and drive large projects as a map of tickets on GitHub Issues, resolving one at a time until the destination is clear.',
};

/**
 * Normalizes a `docs` collection entry id to the Starlight route id it
 * renders at: the collection lives under `src/content/docs/docs/`, so the
 * loader yields ids like `docs/getting-started` and `docs/index` — the
 * trailing `/index` segment is stripped so the docs root's id matches
 * Starlight's own bare `docs`.
 */
function toRouteId(collectionEntryId: string): string {
  return collectionEntryId.replace(/\/index$/, '');
}

export async function getOgPages(): Promise<Record<string, OgPage>> {
  const docsEntries = await getCollection('docs');
  const docsPages = Object.fromEntries(
    docsEntries.map((entry) => [
      toRouteId(entry.id),
      { title: entry.data.title, description: entry.data.description ?? '' },
    ])
  );

  return {
    index: landingPage,
    ...docsPages,
  };
}
