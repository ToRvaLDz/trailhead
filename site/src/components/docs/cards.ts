// Data registry for the per-page docs hero map-cards (#112).
//
// Keyed by the VERIFIED Astro.locals.starlightRoute.id for each page (see
// DocsMarkdownContent.astro), empirically confirmed via a full `astro build`:
// the /docs/ index route's id is the bare "docs" (no trailing slash / index
// segment), every other page is "docs/<slug>".
//
// Content is copied verbatim from the approved mockup
// (docs-illustrations.html)'s 10 gallery cards.

export type RowKind = 'tag' | 'dest' | 'fog';

export interface CardTag {
  variant:
    | 'build'
    | 'bug'
    | 'decision'
    | 'research'
    | 'prototype'
    | 'task'
    | 'todo'
    | 'idea'
    | 'seed'
    | 'frontier'
    | 'guard';
  label: string;
}

export interface CardRow {
  kind: RowKind;
  /** Row-level modifier classes from the mockup (active/done/struck/dashed etc). */
  active?: boolean;
  done?: boolean;
  struck?: boolean;
  /** Tag(s) rendered before the title (a row can carry a leading tag and a trailing tag, e.g. build + frontier). */
  leadingTag?: CardTag;
  title: string;
  trailingTag?: CardTag;
  /** Avatar initials + palette key, rendered at the row's end. */
  avatar?: { initials: string; key: 'mm' | 'al' | 'rs' };
  /** Trailing checkmark (done rows). */
  check?: boolean;
  /** Trailing flag glyph (dest rows). */
  flag?: boolean;
}

export interface CardStage {
  state: 'done' | 'on' | 'wait';
  name: string;
  mark: string;
}

export interface CardChip {
  /** Plain chip text (no key/value split), e.g. "/trailhead:new" with a highlighted verb. */
  prefix?: string;
  key?: string;
  value?: string;
}

export interface Card {
  /** The illustration key: also the `data-illustration` attribute value. */
  key: string;
  title: string;
  /** Right-aligned count/subtitle in the card head. */
  count: string;
  /** Bold portion of `count` rendered inside a <b> (e.g. the leading number). */
  countBold?: string;
  /** Progress bar fill percentage (0-100). */
  barPercent: number;
  /** Bar gradient variant: default (green->accent), success (green->green-bright), warning (accent->accent-2). */
  barVariant?: 'default' | 'success' | 'warning';
  /** Card-level modifier: dashed border (captures/whiteboard). */
  dashed?: boolean;
  /** Shield icon in place of the diamond glyph (hooks). */
  shield?: boolean;
  rows?: CardRow[];
  stages?: CardStage[];
  chips?: CardChip[];
  /** Foot row: optional avatar stack + caption text. */
  foot?: { stackAvatars?: Array<{ initials: string; key: 'mm' | 'al' | 'rs' }>; caption: string };
}

export const cards: Record<string, Card> = {
  docs: {
    key: 'overview',
    title: 'checkout map',
    count: '/18 resolved',
    countBold: '11',
    barPercent: 61,
    rows: [
      {
        kind: 'tag',
        active: true,
        leadingTag: { variant: 'build', label: 'build' },
        title: 'Checkout page UI',
        trailingTag: { variant: 'frontier', label: 'frontier' },
        avatar: { initials: 'MM', key: 'mm' },
      },
      {
        kind: 'tag',
        leadingTag: { variant: 'bug', label: 'bug' },
        title: 'Rate-limit retry',
        avatar: { initials: 'AL', key: 'al' },
      },
      {
        kind: 'tag',
        done: true,
        leadingTag: { variant: 'decision', label: 'decision' },
        title: 'Payment provider',
        check: true,
      },
    ],
    foot: {
      stackAvatars: [
        { initials: 'MM', key: 'mm' },
        { initials: 'AL', key: 'al' },
        { initials: 'RS', key: 'rs' },
      ],
      caption: '3 teammates on the map',
    },
  },

  'docs/getting-started': {
    key: 'getting-started',
    title: 'first map',
    count: '/1 resolved',
    countBold: '0',
    barPercent: 4,
    rows: [
      {
        kind: 'tag',
        active: true,
        leadingTag: { variant: 'build', label: 'build' },
        title: 'Set the destination',
        trailingTag: { variant: 'frontier', label: 'frontier' },
      },
      { kind: 'fog', title: 'Not yet specified' },
    ],
    foot: { caption: 'a brand-new map, one ticket on the frontier' },
  },

  'docs/concepts': {
    key: 'concepts',
    title: 'anatomy of a map',
    count: 'destination → fog',
    barPercent: 45,
    rows: [
      {
        kind: 'dest',
        leadingTag: { variant: 'frontier', label: 'destination' },
        title: 'a working checkout',
        flag: true,
      },
      {
        kind: 'tag',
        done: true,
        leadingTag: { variant: 'decision', label: 'decision' },
        title: 'Payment provider',
        check: true,
      },
      {
        kind: 'tag',
        active: true,
        leadingTag: { variant: 'build', label: 'build' },
        title: 'Checkout page UI',
        trailingTag: { variant: 'frontier', label: 'frontier' },
      },
      { kind: 'fog', title: 'the fog: not yet specified' },
    ],
  },

  'docs/workflow': {
    key: 'workflow',
    title: 'build #42',
    count: '/4 stages',
    countBold: '2',
    barPercent: 50,
    stages: [
      { state: 'done', name: 'Discuss', mark: '✓' },
      { state: 'done', name: 'Plan', mark: '✓' },
      { state: 'on', name: 'Execute', mark: 'now' },
      { state: 'wait', name: 'Verify', mark: 'next' },
    ],
  },

  'docs/ticket-types': {
    key: 'ticket-types',
    title: 'ticket types',
    count: '6 types',
    barPercent: 100,
    rows: [
      { kind: 'tag', leadingTag: { variant: 'decision', label: 'decision' }, title: 'close a choice' },
      { kind: 'tag', leadingTag: { variant: 'research', label: 'research' }, title: 'surface a fact' },
      { kind: 'tag', leadingTag: { variant: 'prototype', label: 'prototype' }, title: 'react to a mockup' },
      { kind: 'tag', leadingTag: { variant: 'build', label: 'build' }, title: 'construct the thing' },
      { kind: 'tag', leadingTag: { variant: 'bug', label: 'bug' }, title: 'fix a defect' },
      { kind: 'tag', leadingTag: { variant: 'task', label: 'task' }, title: 'do manual work' },
    ],
  },

  'docs/commands': {
    key: 'commands',
    title: 'commands',
    count: '20 verbs',
    barPercent: 100,
    chips: [
      { prefix: '/trailhead:', key: 'new' },
      { prefix: '/trailhead:', key: 'work' },
      { prefix: '/trailhead:', key: 'map' },
      { prefix: '/trailhead:', key: 'quick' },
      { prefix: '/trailhead:', key: 'dashboard' },
    ],
  },

  'docs/captures': {
    key: 'captures',
    title: 'whiteboard',
    count: 'map-less',
    barPercent: 100,
    barVariant: 'success',
    dashed: true,
    rows: [
      { kind: 'tag', leadingTag: { variant: 'todo', label: 'todo' }, title: 'Tidy the footer' },
      { kind: 'tag', leadingTag: { variant: 'bug', label: 'bug' }, title: 'Retry logic' },
      { kind: 'tag', leadingTag: { variant: 'idea', label: 'idea' }, title: 'Dark mode toggle' },
      { kind: 'tag', leadingTag: { variant: 'seed', label: 'seed' }, title: 'When v2 ships…' },
    ],
  },

  'docs/teamwork': {
    key: 'teamwork',
    title: 'checkout map',
    count: 'a ticket each',
    barPercent: 52,
    rows: [
      {
        kind: 'tag',
        leadingTag: { variant: 'build', label: 'build' },
        title: 'Checkout page UI',
        avatar: { initials: 'MM', key: 'mm' },
      },
      {
        kind: 'tag',
        leadingTag: { variant: 'bug', label: 'bug' },
        title: 'Rate-limit retry',
        avatar: { initials: 'AL', key: 'al' },
      },
      {
        kind: 'tag',
        leadingTag: { variant: 'decision', label: 'decision' },
        title: 'Payment provider',
        avatar: { initials: 'RS', key: 'rs' },
      },
    ],
    foot: {
      stackAvatars: [
        { initials: 'MM', key: 'mm' },
        { initials: 'AL', key: 'al' },
        { initials: 'RS', key: 'rs' },
      ],
      caption: 'many hands, no collisions',
    },
  },

  'docs/configuration': {
    key: 'configuration',
    title: 'config',
    count: '.trailhead/config.json',
    barPercent: 100,
    chips: [
      { key: 'git', value: 'main' },
      { key: 'isolation', value: 'none' },
      { key: 'tdd', value: 'seams' },
      { key: 'release', value: 'command' },
    ],
  },

  'docs/hooks': {
    key: 'hooks',
    title: 'guards',
    count: 'PreToolUse',
    barPercent: 100,
    barVariant: 'warning',
    shield: true,
    rows: [
      {
        kind: 'tag',
        struck: true,
        leadingTag: { variant: 'bug', label: 'blocked' },
        title: 'git commit — secret in diff',
      },
      {
        kind: 'tag',
        leadingTag: { variant: 'guard', label: 'commit-msg' },
        title: 'Refs: #42 trailer added',
        check: true,
      },
      {
        kind: 'tag',
        leadingTag: { variant: 'guard', label: 'label-guard' },
        title: 'trailhead:* labels intact',
        check: true,
      },
    ],
  },
};
