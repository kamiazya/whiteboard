import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { NodeResource, SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { FacetCardData } from '../../references/resolved.js'
import { ID } from '../typeset-oracle/hand-builders.js'

/**
 * The inputs of the compose-node recording: what a node shows, the boxes it is
 * drawn in, and the options and host answers a composer hands `composeNode`.
 * Every choice that is not a product is a pure function of the case's index, so
 * the corpus is the same on every run.
 */

/** The text that makes the recording's body parser throw. */
export const THROWING_BODY = '<<throw>>'

/** The id `[[doc]]` and `![[doc]]` resolve to, and the one document embed target answered. */
export const DOC_ID = ID

/** The id `![[board]]` resolves to, and the one canvas embed target answered. */
export const BOARD_ID = '01HZX3Q8K9V2M4N5P6R7S8T9WB'

/** What the recording's bodies resolve an alias to; `null` is an alias nothing holds. */
export const resolveAlias = (alias: string): string | null =>
  alias === 'doc' ? DOC_ID : alias === 'board' ? BOARD_ID : null

/**
 * A canvas of five elements: three nodes, an edge and a line. Only its count is
 * read, since the nested layout's answer is fixed; the line is what makes a count
 * that forgets the ink differ.
 */
export const BOARD_CANVAS = {
  nodes: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
  edges: [{ id: 'e1', fromNode: 'b1', toNode: 'b2' }],
  lines: [{ id: 'l1' }],
} as unknown as SpatialCanvas

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

/**
 * File nodes by name and the reference each points at: a body, a tall body, an
 * empty body over a card, cards with and without a usable title or row (the
 * blanks are `String.prototype.trim`'s: U+FEFF is blank and U+0085 is not), a
 * picture over a body, a canvas over a body, a missing target, and a resolver
 * that throws.
 */
const FILE_REFERENCES: Readonly<Record<string, string>> = {
  'file-md': 'md:doc',
  'file-md-tall': 'md:tall',
  'file-md-empty': 'md:empty',
  'file-card': 'card:full',
  'file-card-untitled': 'card:untitled',
  'file-card-blank': 'card:blank',
  'file-card-none': 'card:none',
  'file-pic-md': 'pic:md',
  'file-board': 'board',
  'file-gone': 'gone',
  'file-throws': 'throws',
}

/**
 * What a node shows that the main sweep passes over, so the cases it draws keep
 * their options: a body over a canvas embed, and a file node whose canvas sits
 * over a body that itself embeds, where what the canvas spent decides the body.
 */
const LATE_RESOURCES: Readonly<Record<string, NodeResource>> = {
  'text-board': { mimeType: 'text/markdown', content: 'Over the board\n\n![[board]]' },
  'file-board-embeds': { mimeType: 'application/octet-stream', location: 'board-embeds' },
}

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
  ...Object.fromEntries(
    Object.entries(FILE_REFERENCES).map(([name, location]) => [
      name,
      { mimeType: 'application/octet-stream', location },
    ]),
  ),
  'file-md-sub': {
    mimeType: 'application/octet-stream',
    location: 'md:doc',
    subpath: '#Heading',
  },
  ...LATE_RESOURCES,
}

/** What a reference resolves to, by the reference; `null` is a resolver that throws. */
export type ResolvedWire = {
  readonly label?: string
  readonly missing?: boolean
  readonly image?: { readonly href: string; readonly alt?: string }
  readonly canvas?: SpatialCanvas
  readonly markdown?: MdastRoot
  readonly facets?: FacetCardData
} | null

const md = (text: string): MdastRoot =>
  JSON.parse(JSON.stringify(resolveReferences(parseMarkdownBody(text), resolveAlias)))

const TALL_BODY = [
  ...Array.from({ length: 10 }, (_, i) => `Paragraph ${i} of the referenced document`),
  '- one\n- two words\n  - three',
  '```js\nconst a = 1\n```',
].join('\n\n')

export const REFERENCES: Readonly<Record<string, ResolvedWire>> = {
  'asset:bg': { image: { href: 'blob:bg', alt: 'Background' } },
  'asset:plain': { image: { href: 'blob:plain' } },
  'doc-ref': { label: 'Doc' },
  'notes/a.md': { label: 'Notes A' },
  throws: null,
  'md:doc': {
    label: 'Doc MD',
    markdown: md('# Heading\n\nA paragraph in the referenced document that wraps'),
  },
  'md:tall': { markdown: md(TALL_BODY) },
  'md:empty': {
    label: 'Empty',
    markdown: { type: 'root', children: [] },
    facets: { title: 'Fallback card', rows: [{ label: 'type', value: 'note' }] },
  },
  'card:full': {
    label: 'Card',
    facets: {
      title: 'Spec',
      rows: [
        { label: 'type', value: 'note' },
        { label: ' ', value: '\u3000' },
        { label: '', value: 'unlabelled' },
        { label: 'tags', value: 'alpha, beta and a longer value that wraps in the card' },
      ],
    },
  },
  'card:untitled': { facets: { title: ' \uFEFF', rows: [{ label: '\u0085', value: '' }] } },
  'card:blank': { facets: { title: '\t', rows: [{ label: ' ', value: '\n' }] } },
  'card:none': { facets: { rows: [] } },
  'pic:md': { image: { href: 'blob:pic', alt: 'Picture' }, markdown: md('Under the picture') },
  board: {
    label: 'Board',
    canvas: { nodes: [], edges: [] } as unknown as SpatialCanvas,
    markdown: md('Board notes'),
  },
  'board-embeds': { label: 'Board E', canvas: BOARD_CANVAS, markdown: md('![[doc]]') },
  gone: { missing: true, markdown: md('Still here') },
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
  /** Whether the expansion policy keeps a file node's canvas collapsed. */
  readonly collapsed: boolean
  /** The layouts and elements left in the render's budget, when not the default. */
  readonly budget?: readonly [number, number]
  /** The documents being laid out around the node, when there are any. */
  readonly embedPath?: readonly string[]
}

const pick = <T>(list: readonly T[], at: number): T => list[at % list.length] as T

/**
 * Every resource in every box, with the options drawn round-robin at co-prime
 * strides so each combination is reached without the product; then the text
 * bodies again under every theme with a cache, and once more with the budget
 * spent, which is what the cache refuses to keep; then every file node fitted
 * and not, plain and shaped, and once with the budget spent, which the canvas
 * embed needs; then every frame background in every fill, in a box and in one
 * with no width or no height; then a picture whose padded box is empty one way.
 */
export function caseSpecs(): readonly CaseSpec[] {
  const specs: CaseSpec[] = []
  let at = 0
  const push: Push = (resource, box, extra = {}) => {
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
      collapsed: false,
      ...extra,
    })
    at += 1
  }
  sweep(push)
  return specs
}

type Push = (resource: string, box: CaseSpec['box'], extra?: Partial<CaseSpec>) => void

function sweep(push: Push): void {
  const names = Object.keys(RESOURCES).filter((name) => !(name in LATE_RESOURCES))
  for (const resource of names) {
    for (const box of BOXES) push(resource, box)
  }
  const texts = names.filter((name) => name.startsWith('text'))
  for (const resource of texts) {
    for (const theme of THEMES) push(resource, [10, 20, 200, 120], { theme, cache: true })
    push(resource, [10, 20, 200, 120], { cache: true, spent: true, suppressed: false })
  }
  const files = names.filter((name) => name.startsWith('file'))
  for (const resource of files) {
    for (const fitToBox of [true, false]) {
      for (const shape of SHAPES.slice(0, 2)) {
        push(resource, [10, 20, 200, 120], { fitToBox, shape, spent: false })
      }
    }
    push(resource, [10, 20, 200, 120], { spent: true })
  }
  for (const background of BACKGROUNDS) {
    for (const backgroundStyle of BACKGROUND_STYLES) {
      push('frame', [5, 6, 180, 90], { background, backgroundStyle })
      push('frame', [0, 0, 0, 40], { background, backgroundStyle })
      push('frame', [0, 0, 40, 0], { background, backgroundStyle })
    }
  }
  // A picture whose padded box is exactly empty one way: it is not drawn.
  for (const box of [
    [0, 0, 16, 60],
    [0, 0, 60, 16],
  ] as const) {
    push('file-pic-md', box, { geometry: [8, 16, 0], fitToBox: false })
  }
  lateSweep(push)
}

/**
 * The canvas embeds: the body's in every box and theme and with the budget
 * spent; then the file node's canvas over an embedding body in every box, and
 * on each side of each thing that keeps it from drawing — the policy, the depth
 * cap, the path, the budget's layouts and elements, and a fit with no room,
 * which the TypeScript reaches only after the canvas has spent.
 */
function lateSweep(push: Push): void {
  for (const box of BOXES) push('text-board', box)
  for (const theme of THEMES) push('text-board', [10, 20, 200, 120], { theme, cache: true })
  push('text-board', [10, 20, 200, 120], { cache: true, spent: true, suppressed: false })
  const file = 'file-board-embeds'
  const box = [10, 20, 200, 120] as const
  const plain = { fitToBox: false, shape: null, locked: false, spent: false, embedDepth: 0 }
  for (const at of BOXES) push(file, at, { spent: false })
  for (const collapsed of [false, true]) push(file, box, { ...plain, collapsed })
  for (const embedDepth of [2, 3]) push(file, box, { ...plain, embedDepth })
  for (const embedPath of [['other'], ['board-embeds'], ['other', 'board-embeds']]) {
    push(file, box, { ...plain, embedPath })
  }
  for (const budget of [
    [1, 5],
    [0, 5],
    [5, 4],
    [5, 5],
  ] as const) {
    push(file, box, { ...plain, budget })
  }
  // A box with no room one way: the canvas spends before its fit is refused,
  // so with one layout left the body's own embed finds the account empty.
  for (const budget of [
    [1, 4000],
    [2, 4000],
  ] as const) {
    push(file, [0, 0, 16, 60], { ...plain, geometry: [8, 16, 0], budget })
    push(file, [0, 0, 60, 16], { ...plain, geometry: [8, 16, 0], budget })
  }
}
