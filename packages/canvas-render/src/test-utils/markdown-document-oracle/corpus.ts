import { BOUNDARY_BODIES, CAP_BODIES, HAND_BODIES, repositoryBodies } from './bodies.js'
import { MARKDOWN_TABLES } from './fixtures.js'
import type { MarkdownInput, Surface } from './oracle.js'

/**
 * Every markdown-document case, grouped by the surface it is recorded under
 * (`layout-markdown.<surface>.jsonl`). Each surface lays out the hand bodies
 * and the boundary bodies under the variants its root can hand; the
 * repository's docs and skills go through the two surfaces a whole document
 * reaches most, the daemon's render (all of them) and the web preview (a
 * sample); the bodies at the cap, held as digests, go through the daemon's.
 */

/** The fonts a sketch board names, held or not. */
const HELD = ['Yomogi']

/** What the daemon's `wb_scene_render` can be handed: with and without references, each style. */
const DAEMON_VARIANTS: readonly Omit<MarkdownInput, 'id' | 'surface' | 'body' | 'maxWidth'>[] = [
  { fonts: [] },
  { fonts: [], references: true, library: true },
  { fonts: HELD, references: true, style: 'document' },
  { fonts: [], references: true, style: 'visual.neon' },
]

/** The web preview's variants: the app theme, the fragment table, the families this realm holds. */
const PREVIEW_VARIANTS: readonly Omit<MarkdownInput, 'id' | 'surface' | 'body' | 'maxWidth'>[] = [
  { mode: 'light', fonts: [], references: true, fragments: 'full', library: true },
  { mode: 'dark', fonts: HELD, references: true, fragments: 'empty' },
  { mode: 'light', fonts: [] },
]

const THUMBNAIL_VARIANTS: readonly Omit<MarkdownInput, 'id' | 'surface' | 'body' | 'maxWidth'>[] = [
  { mode: 'light', fonts: [], references: true, library: true },
  { mode: 'dark', fonts: HELD, references: true },
]

/** The preview pane's default measure, a narrow pane and a wide one; rows and the outline use 640. */
const PREVIEW_WIDTHS = [720, 360, 1100]
const ROW_WIDTH = 640

const SECTIONS = ['Part two', 'Note', 'Nonesuch']

type Named = readonly (readonly [string, string])[]

function across(
  surface: Surface,
  bodies: Named,
  variants: readonly Omit<MarkdownInput, 'id' | 'surface' | 'body' | 'maxWidth'>[],
  widths: readonly number[],
): MarkdownInput[] {
  return bodies.flatMap(([name, body], b) =>
    variants.map((variant, v) => ({
      id: `${surface}/${name}#${v}`,
      surface,
      body,
      maxWidth: widths[(b + v) % widths.length] as number,
      ...variant,
    })),
  )
}

const once = (surface: Surface, bodies: Named, rest: Partial<MarkdownInput>, maxWidth: number) =>
  bodies.map(([name, body]) => ({ id: `${surface}/${name}`, surface, body, maxWidth, ...rest }))

function daemonCases(docs: Named): MarkdownInput[] {
  const note = MARKDOWN_TABLES.references.entries.find(([key]) => key === 'note')?.[1]?.body ?? ''
  return [
    ...across('daemon', [...HAND_BODIES, ...BOUNDARY_BODIES], DAEMON_VARIANTS, [720]),
    ...SECTIONS.map((section) => ({
      id: `daemon/section ${section}`,
      surface: 'daemon' as const,
      body: note,
      maxWidth: 720,
      fonts: [],
      references: true as const,
      section,
    })),
    ...once('daemon', docs, { fonts: [], references: true }, 720),
    ...once('daemon', CAP_BODIES, { fonts: [], digest: true }, 720),
  ]
}

/**
 * The documents that embed and one in eight of the rest, each under 32 KB:
 * the preview differs from the daemon in its options, not in the documents
 * it is handed, and the daemon's file already holds every one whole.
 */
const sampled = (docs: Named): Named =>
  docs.filter(([, body], i) => (body.includes('![[') || i % 8 === 0) && body.length < 32_000)

function previewCases(docs: Named): MarkdownInput[] {
  return [
    ...across('preview', [...HAND_BODIES, ...BOUNDARY_BODIES], PREVIEW_VARIANTS, PREVIEW_WIDTHS),
    ...once('preview', sampled(docs), { mode: 'light', fonts: [], references: true }, 720),
  ]
}

function outlineCases(): MarkdownInput[] {
  return [...once('outline', [...HAND_BODIES, ...BOUNDARY_BODIES], {}, ROW_WIDTH)]
}

function thumbnailCases(): MarkdownInput[] {
  return across('thumbnail', HAND_BODIES, THUMBNAIL_VARIANTS, [ROW_WIDTH])
}

/** The rail's measured widths, the unmeasured guess less its padding, and a column narrower than a word. */
const COMMENT_WIDTHS = [198, 298, 120, 40]

function commentCases(): MarkdownInput[] {
  return [...HAND_BODIES, ...BOUNDARY_BODIES].flatMap(([name, body], b) =>
    (['comfortable', 'compact'] as const).map((density, d) => ({
      id: `comment/${name}#${density}`,
      surface: 'comment' as const,
      body,
      maxWidth: COMMENT_WIDTHS[(b + d) % COMMENT_WIDTHS.length] as number,
      density,
    })),
  )
}

/** Every case, by surface. */
export function markdownCases(): Map<Surface, MarkdownInput[]> {
  const docs = repositoryBodies()
  return new Map<Surface, MarkdownInput[]>([
    ['daemon', daemonCases(docs)],
    ['preview', previewCases(docs)],
    ['outline', outlineCases()],
    ['thumbnail', thumbnailCases()],
    ['comment', commentCases()],
  ])
}
