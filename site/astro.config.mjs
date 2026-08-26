import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  output: 'static',
  site: 'https://trailhead.marcomigozzi.it',
  integrations: [
    starlight({
      title: 'trailhead',
      // English served unprefixed at `/docs/`; a future locale would be
      // prefixed (e.g. `/it/docs/`) while `root` stays unprefixed.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
      },
      sidebar: [
        { label: 'Docs', items: [{ autogenerate: { directory: 'docs' } }] },
      ],
    }),
  ],
});
