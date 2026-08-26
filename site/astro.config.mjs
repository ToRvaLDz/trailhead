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
  ],
});
