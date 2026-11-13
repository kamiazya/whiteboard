import type { NodeResource } from '@kamiazya/whiteboard-model'
import { ID } from '../typeset-oracle/hand-builders.js'

/**
 * The inputs of the compose-node recording: what a node shows, the boxes it is
 * drawn in, and the options and host answers a composer hands `composeNode`.
 * Every choice that is not a product is a pure function of the case's index, so
 * the corpus is the same on every run.
 */

/** The text that makes the recording's body parser throw. */
export const THROWING_BODY = '<<throw>>'

/** The id `[[doc]]` and `![[doc]]` resolve to, and the one embed target answered. */
export const DOC_ID = ID

/**
 * Bodies a text node carries. None holds a colon in its prose, so the emoji and
 * icon shortcode seams have nothing to answer.
 */
const BODIES: readonly string[] = [
  'Hello',
  '',
  'The quick brown fox jumps over the lazy dog and keeps running far away from here',
  '# Title\n\nA paragraph that wraps under the title more than once',
  '- one\n- two words\n  - three',
  Array.from({ length: 12 }, (_, i) => `Paragraph ${i}`).join('\n\n'),
  '![[doc]]',
  'Before\n\n![[doc]]\n\nAfter the embed',
  '![[missing]]',
  THROWING_BODY,
  '日本語の文章はここで折り返されるべきです',
  'A [[doc]] link, `code` and **bold** text',
  '```js\nconst a = 1\n```',
]

/** What a node shows, by name; `null` is a frame. */
export const RESOURCES: Readonly<Record<string, NodeResource | null>> = {
  ...Object.fromEntries(
    BODIES.map((body, at) => [`text${at}`, { mimeType: 'text/markdown', content: body }]),
  ),
  'link-mime-content': { mimeType: 'text/uri-list', content: 'carried text wins' },
  file: { mimeType: 'application/octet-stream', location: 'notes/a.md' },
  image: { mimeType: 'image/png', location: 'asset:bg' },
  link: { mimeType: 'text/uri-list', location: 'https://example.com/a?b=c' },
  'link-empty': { mimeType: 'text/uri-list', location: '' },
  unclaimed: { mimeType: 'image/png' },
  frame: null,
}

/** What a reference resolves to, by the reference; `null` is a resolver that throws. */
export type ResolvedWire = {
  readonly label?: string
  readonly missing?: boolean
  readonly image?: { readonly href: string; readonly alt?: string }
} | null

export const REFERENCES: Readonly<Record<string, ResolvedWire>> = {
  'asset:bg': { image: { href: 'blob:bg', alt: 'Background' } },
  'asset:plain': { image: { href: 'blob:plain' } },
  'doc-ref': { label: 'Doc' },
  'notes/a.md': { label: 'Notes A' },
  throws: null,
}

/** A frame's caption, background and how it fills the frame. */
const FRAME_LABELS: readonly (string | undefined)[] = ['Group A', '', undefined, '日本語のグループ']
const BACKGROUNDS: readonly (string | undefined)[] = [
  'asset:bg',
  undefined,
  'asset:plain',
  'doc-ref',
  'throws',
  'unknown',
]
const BACKGROUND_STYLES: readonly ('cover' | 'ratio' | 'repeat' | undefined)[] = [
  undefined,
  'cover',
  'ratio',
  'repeat',
]

/** `[x, y, w, h]`: ordinary, short, small, degenerate, negative and non-finite boxes. */
const BOXES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 160, 100],
  [12.5, -30.25, 240, 60],
  [100, 100, 60, 25],
  [0, 0, 0, 0],
  [0, 0, -20, 40],
  [0, 0, Number.NaN, 50],
  [3, 4, 300, 400],
]

const SHAPES: readonly (string | null)[] = [null, 'visual.ellipse', 'visual.cylinder', null]
type ThemeName = 'light' | 'dark' | 'sketch'
const THEMES: readonly ThemeName[] = ['light', 'dark', 'sketch']
const ALIGNS: readonly ('start' | 'center' | null)[] = [null, 'start', 'center']
const COLORS: readonly (string | null)[] = [null, '3', '#ff0000']

/** `[padding, label size, minimum content width]`. */
const GEOMETRIES: readonly (readonly [number, number, number])[] = [
  [8, 16, 0],
  [0, 12, 30],
  [20, 16, 400],
]

/** A case's options and host answers, chosen from its index. */
export interface CaseSpec {
  readonly id: string
  readonly resource: string
  readonly frameLabel: string | undefined
  readonly background: string | undefined
  readonly backgroundStyle: 'cover' | 'ratio' | 'repeat' | undefined
  readonly box: readonly [number, number, number, number]
  readonly shape: string | null
  readonly theme: ThemeName
  readonly fitToBox: boolean
  readonly align: 'start' | 'center' | null
  readonly color: string | null
  readonly geometry: readonly [number, number, number]
  readonly locked: boolean
  readonly embedDepth: number
  readonly suppressed: boolean
  readonly emptyFrame: boolean
  /** Whether the composer is handed a content cache. */
  readonly cache: boolean
  /** Whether the render's nested-layout budget is already spent. */
  readonly spent: boolean
}

const pick = <T>(list: readonly T[], at: number): T => list[at % list.length] as T

/**
 * Every resource in every box, with the options drawn round-robin at co-prime
 * strides so each combination is reached without the product; then the text
 * bodies again under every theme with a cache, and once more with the budget
 * spent, which is what the cache refuses to keep; then every frame background
 * in every fill, in a box and in one with no width.
 */
export function caseSpecs(): readonly CaseSpec[] {
  const specs: CaseSpec[] = []
  let at = 0
  const push = (resource: string, box: CaseSpec['box'], extra: Partial<CaseSpec> = {}) => {
    specs.push({
      id: `${specs.length}/${resource}`,
      resource,
      frameLabel: resource === 'frame' ? pick(FRAME_LABELS, at) : undefined,
      background: resource === 'frame' ? pick(BACKGROUNDS, at * 5 + 1) : undefined,
      backgroundStyle: resource === 'frame' ? pick(BACKGROUND_STYLES, at * 7 + 2) : undefined,
      box,
      shape: pick(SHAPES, at * 3),
      theme: pick(THEMES, at),
      fitToBox: at % 5 !== 4,
      align: pick(ALIGNS, at * 5 + 1),
      color: pick(COLORS, at * 7 + 2),
      geometry: pick(GEOMETRIES, at * 2 + 1),
      locked: at % 4 === 1,
      embedDepth: at % 9 === 2 ? 1 : 0,
      suppressed: at % 11 === 3,
      emptyFrame: at % 2 === 0,
      cache: at % 3 !== 0,
      spent: at % 13 === 6,
      ...extra,
    })
    at += 1
  }
  const names = Object.keys(RESOURCES)
  for (const resource of names) {
    for (const box of BOXES) {
      // A file node's drawing is recorded as JSON, which has no NaN to carry.
      const shown = RESOURCES[resource]
      const file = shown?.location !== undefined && shown.mimeType !== 'text/uri-list'
      if (!(file && box.some((v) => !Number.isFinite(v)))) push(resource, box)
    }
  }
  const texts = names.filter((name) => name.startsWith('text'))
  for (const resource of texts) {
    for (const theme of THEMES) push(resource, [10, 20, 200, 120], { theme, cache: true })
    push(resource, [10, 20, 200, 120], { cache: true, spent: true, suppressed: false })
  }
  for (const background of BACKGROUNDS) {
    for (const backgroundStyle of BACKGROUND_STYLES) {
      push('frame', [5, 6, 180, 90], { background, backgroundStyle })
      push('frame', [0, 0, 0, 40], { background, backgroundStyle })
    }
  }
  return specs
}
