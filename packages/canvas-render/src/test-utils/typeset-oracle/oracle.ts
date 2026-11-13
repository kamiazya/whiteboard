import type {
  MdastFlowContent,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { expandEmojiShortcodes } from '@kamiazya/whiteboard-plugin-visual/emoji/shortcode'
import { iconShortcodeRanges } from '@kamiazya/whiteboard-plugin-visual/icons/shortcode'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { highlightCode } from '../../highlight/lowlight.js'
import { createTokenizerBudget } from '../../highlight/tokenizer-budget.js'
import { typesetMdastBlocks } from '../../layout/nodes/mdast-blocks.js'
import type {
  EmbeddedCanvasBox,
  MdastLayoutOptions,
} from '../../layout/nodes/mdast-layout-options.js'
import type { FontDescriptor, TextMetrics } from '../../measure.js'
import type { ReferenceSeams } from '../../references/seams.js'
import {
  MARKDOWN_THEME_COMPACT,
  MARKDOWN_THEME_DOCUMENT,
  MARKDOWN_THEME_NODE,
  type MarkdownTheme,
} from '../../theme/markdown-theme.js'
import { createFakeMeasure } from '../fake-measure.js'
import { dumpScene, f64Hex } from '../render-oracle/scene-dump.js'
import {
  type CanvasSummary,
  type EmbeddedWire,
  embedClosure,
  embeddedDocumentOf,
  embeddedWireOf,
  fragmentKey,
  type MiniatureMode,
  miniatureModeOf,
  summaryOf,
} from './embed-fixtures.js'

/**
 * The recorded answers of `typesetMdastBlocks` for the blocks the Rust
 * typesetter has ported so far. A record holds its inputs,
 * the answers of the seams the layout reads from its host, and what the layout
 * answered: the scene as `dumpScene` writes it (every double as its IEEE bits,
 * keys sorted) or, for the big sets, its length and FNV digest, and how many
 * times the measurer was asked, which pins the probe sequence of the width
 * search as well as its result.
 */

export type ThemeName = 'node' | 'document' | 'compact'

/** What the host answered for the questions this input can ask. */
interface SeamTables {
  /** An icon range is in UTF-16 units, as the host's answer is. */
  readonly icons: Readonly<Record<string, readonly { from: number; to: number; name: string }[]>>
  readonly emoji: Readonly<Record<string, string>>
  readonly titles: Readonly<Record<string, string | null>>
  readonly embeds: Readonly<Record<string, string | null>>
  readonly pending: readonly string[]
  readonly images: Readonly<
    Record<string, { href: string; width?: number; height?: number } | null>
  >
  /** Token lines per `lang NUL source`; null where the seam threw or answered nothing. */
  readonly highlight: Readonly<Record<string, TokenLinesWire | null>>
  /** The math renderer's answer per source; null where it threw or answered nothing. */
  readonly math: Readonly<Record<string, RenderedWire | null>>
  /** The diagram renderer's answer per `lang NUL source`. */
  readonly diagram: Readonly<Record<string, RenderedWire | null>>
  /** What resolving each embed target answers; empty where the seam is absent. */
  readonly embedded: Readonly<Record<string, EmbeddedWire | null>>
  /** What a fragment keeps of a canvas target, per `id NUL fragment`. */
  readonly canvases: Readonly<Record<string, CanvasSummary>>
  /** How the host draws each canvas target's miniature. */
  readonly miniatures: Readonly<Record<string, MiniatureMode>>
}

/** Which embed seams the host supplies: none, the documents', or those and the canvas picture. */
export type EmbedSeams = 'none' | 'documents' | 'full'

type TokenLinesWire = readonly (readonly { text: string; role?: string }[])[]
/** `s` is the string form a renderer may answer; the other is the object form. */
type RenderedWire = { s: string } | { svg: string; width?: number; height?: number }

export interface TypesetInput {
  readonly id: string
  readonly root: MdastRoot
  /** The wrap width's IEEE bits, since JSON cannot hold NaN or infinity. */
  readonly width: string
  readonly theme: ThemeName
  readonly fill: string | null
  readonly embeds: EmbedSeams
  /** The fill of each token role, when the caller supplies a palette. */
  readonly syntax: Readonly<Record<string, string>> | null
  /** Hold the answer as a digest rather than as text. */
  readonly digest: boolean
  /** The documents the host is already laying out around this body; absent, none. */
  readonly embedPath?: readonly string[]
}

export type TypesetRecord = TypesetInput & {
  readonly seams: SeamTables
  readonly calls: number
} & ({ readonly scene: string } | { readonly n: number; readonly h: number })

export interface RecordMeta {
  readonly kind: 'meta'
  readonly seed: number
  readonly generated: number
}

const THEMES: Record<ThemeName, MarkdownTheme> = {
  node: MARKDOWN_THEME_NODE,
  document: MARKDOWN_THEME_DOCUMENT,
  compact: MARKDOWN_THEME_COMPACT,
}

const view = new DataView(new ArrayBuffer(8))
export function fromHex(hex: string): number {
  view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16))
  view.setUint32(4, Number.parseInt(hex.slice(8), 16))
  return view.getFloat64(0)
}

export { f64Hex }

const hashOf = (text: string): number => {
  let state = 0x811c_9dc5
  for (let i = 0; i < text.length; i += 1) {
    state = Math.imul(state ^ text.charCodeAt(i), 16_777_619) >>> 0
  }
  return state
}

/** What a host answers for an id or a url: a pure function of it, so a record can hold the table. */
const titleOf = (id: string): string | null =>
  hashOf(id) % 3 === 0 ? null : `Title ${id.slice(0, 6)}`
const pendingOf = (id: string): boolean => hashOf(`p${id}`) % 4 === 0
const imageOf = (url: string): SeamTables['images'][string] => {
  const h = hashOf(`i${url}`) % 4
  if (h === 0) return null
  const href = `img:${url.slice(0, 12)}`
  if (h === 1) return { href }
  return { href, width: 40 + (hashOf(url) % 400), height: 30 + (hashOf(`h${url}`) % 300) }
}

type Inline = MdastPhrasingContent
const childrenOf = (node: Inline): readonly Inline[] => ('children' in node ? node.children : [])

function walkInline(nodes: readonly Inline[], visit: (node: Inline) => void): void {
  for (const node of nodes) {
    visit(node)
    walkInline(childrenOf(node), visit)
  }
}

/** Every flow block of a tree, containers' content included, in document order. */
function flowsOf(blocks: readonly MdastFlowContent[]): MdastFlowContent[] {
  return blocks.flatMap((block): MdastFlowContent[] => {
    if (block.type === 'blockquote') return [block, ...flowsOf(block.children)]
    if (block.type === 'list') {
      return [block, ...flowsOf(block.children.flatMap((item) => item.children))]
    }
    return [block]
  })
}

const inlinesOf = (root: MdastRoot): readonly Inline[] =>
  flowsOf(root.children).flatMap((block) => {
    if (block.type === 'paragraph' || block.type === 'heading') return block.children
    if (block.type === 'table') {
      return block.children.flatMap((row) => row.children.flatMap((cell) => cell.children))
    }
    return []
  })

const keyOf = (lang: string, value: string): string => `${lang}\u0000${value}`

/** What the highlighter answers for a fence, one in seven of them faulty on purpose. */
function highlightFor(lang: string, value: string) {
  const fault = hashOf(`hl${keyOf(lang, value)}`) % 7
  if (fault === 0) throw new Error('highlighter failed')
  if (fault === 1) return undefined
  const lines = highlightCode(lang, value, createTokenizerBudget())
  // A line count that disagrees with the source, which the layout has to refuse.
  return fault === 2 && lines !== undefined ? [...lines, [{ text: '' }]] : lines
}

type Rendered = string | { svg: string; width?: number; height?: number } | undefined

/** What a math or diagram renderer answers: every shape the layout reads, and failures. */
function renderedFor(salt: string, key: string): Rendered {
  const h = hashOf(`${salt}${key}`)
  switch (h % 7) {
    case 0:
      return undefined
    case 1:
      throw new Error('renderer failed')
    case 2:
      return `<path d="M${key.length}"/>`
    case 3:
      return { svg: `<g id="${h % 100}"/>`, width: 40 + (h % 90), height: 20 + (h % 60) }
    case 4:
      return { svg: '<g/>', width: 5000, height: 0 }
    case 5:
      return { svg: '<g/>' }
    default:
      return { svg: '<g/>', width: -3, height: 12.5 }
  }
}

const mathFor = (value: string): Rendered => renderedFor('m', value)
const diagramFor = (lang: string, value: string): Rendered => renderedFor('d', keyOf(lang, value))

const attempt = <T>(answer: () => T): T | undefined => {
  try {
    return answer()
  } catch {
    return undefined
  }
}

const wireOf = (rendered: Rendered): RenderedWire | null =>
  rendered === undefined ? null : typeof rendered === 'string' ? { s: rendered } : rendered

/** What the host answers about the fences and the display math of a tree. */
function blockSeams(root: MdastRoot): Pick<SeamTables, 'highlight' | 'math' | 'diagram'> {
  const highlight: Record<string, TokenLinesWire | null> = {}
  const math: Record<string, RenderedWire | null> = {}
  const diagram: Record<string, RenderedWire | null> = {}
  for (const block of flowsOf(root.children)) {
    if (block.type === 'math') math[block.value] = wireOf(attempt(() => mathFor(block.value)))
    if (block.type !== 'code') continue
    const lang = block.lang ?? ''
    highlight[keyOf(lang, block.value)] = (attempt(() => highlightFor(lang, block.value)) ??
      null) as TokenLinesWire | null
    if (lang !== '') {
      diagram[keyOf(lang, block.value)] = wireOf(attempt(() => diagramFor(lang, block.value)))
    }
  }
  return { highlight, math, diagram }
}

/** Every question the layout can put to its host about this tree, answered. */
function seamsOfTree(root: MdastRoot, mode: EmbedSeams): SeamTables {
  const icons: Record<string, { from: number; to: number; name: string }[]> = {}
  const emoji: Record<string, string> = {}
  const titles: Record<string, string | null> = {}
  const embeds: Record<string, string | null> = {}
  const pending: string[] = []
  const images: Record<string, SeamTables['images'][string]> = {}
  const ask = (id: string) => {
    titles[id] = titleOf(id)
    embeds[id] = mode === 'none' ? null : (embeddedWireOf(id)?.title ?? null)
    if (pendingOf(id)) pending.push(id)
  }
  walkInline(inlinesOf(root), (node) => {
    if (node.type === 'text') {
      const ranges = [...iconShortcodeRanges(node.value)].map(({ from, to, name }) => ({
        from,
        to,
        name,
      }))
      icons[node.value] = ranges
      let at = 0
      for (const range of ranges) {
        if (range.from > at)
          emoji[node.value.slice(at, range.from)] = expandEmojiShortcodes(
            node.value.slice(at, range.from),
          )
        at = range.to
      }
      const rest = at === 0 ? node.value : node.value.slice(at)
      if (at === 0 || at < node.value.length) emoji[rest] = expandEmojiShortcodes(rest)
    } else if (node.type === 'wikiLink' || node.type === 'embed') ask(node.documentId)
    else if (node.type === 'image') images[node.url] = imageOf(node.url)
  })
  return {
    icons,
    emoji,
    titles,
    embeds,
    pending: [...new Set(pending)],
    images,
    ...blockSeams(root),
    embedded: {},
    canvases: {},
    miniatures: {},
  }
}

/** Every question the layout can put to its host about this tree and the documents it embeds. */
function seamsFor(root: MdastRoot, mode: EmbedSeams): SeamTables {
  const { pairs, roots } = embedClosure(root)
  const parts = [root, ...roots].map((tree) => seamsOfTree(tree, mode))
  const merge = <T>(pick: (part: SeamTables) => Readonly<Record<string, T>>) =>
    Object.assign({}, ...parts.map(pick)) as Record<string, T>
  const embedded: Record<string, EmbeddedWire | null> = {}
  const canvases: Record<string, CanvasSummary> = {}
  const miniatures: Record<string, MiniatureMode> = {}
  if (mode !== 'none') {
    for (const [id, fragment] of pairs.values()) {
      const wire = embeddedWireOf(id)
      embedded[id] = wire
      if (wire?.kind !== 'canvas') continue
      canvases[fragmentKey(id, fragment)] = summaryOf(id, fragment)
      if (mode === 'full') miniatures[id] = miniatureModeOf(id)
    }
  }
  return {
    icons: merge((p) => p.icons),
    emoji: merge((p) => p.emoji),
    titles: merge((p) => p.titles),
    embeds: merge((p) => p.embeds),
    pending: [...new Set(parts.flatMap((p) => p.pending))],
    images: merge((p) => p.images),
    highlight: merge((p) => p.highlight),
    math: merge((p) => p.math),
    diagram: merge((p) => p.diagram),
    embedded,
    canvases,
    miniatures,
  }
}

function referencesFor(seams: SeamTables, mode: EmbedSeams): ReferenceSeams {
  const pending = new Set(seams.pending)
  const references: ReferenceSeams = {
    resolveAlias: () => null,
    resolveTitle: (id) => seams.titles[id] ?? undefined,
    resolveEmbed: (id) => embeddedDocumentOf(id),
    isLoading: (id) => pending.has(id),
    resolveReference: (url) => {
      const image = seams.images[url]
      return image === null || image === undefined ? undefined : { image }
    },
  }
  // A host without the embed seam leaves it undefined, which `withReferenceSeams` reads as absent.
  return mode === 'none'
    ? ({ ...references, resolveEmbed: undefined } as unknown as ReferenceSeams)
    : references
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** `JSON.stringify` escapes a lone surrogate to plain ASCII, so the strings must be read before the dump. */
function holdsHalfAPair(value: unknown): boolean {
  if (typeof value === 'string') return LONE_SURROGATE.test(value)
  if (Array.isArray(value)) return value.some(holdsHalfAPair)
  if (value !== null && typeof value === 'object') return Object.values(value).some(holdsHalfAPair)
  return false
}

class Fnv {
  state = 0x811c_9dc5
  text(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      this.state = Math.imul(this.state ^ text.charCodeAt(i), 16_777_619) >>> 0
    }
  }
}

/** `f64Hex`, with every NaN written as the positive quiet NaN `f64::NAN` is. */
function canonicalNanHex(value: number): string {
  return Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value)
}

/** How the host draws a canvas target: its picture is a box of the shape its mode says. */
function miniatureFor(_canvas: unknown, box: EmbeddedCanvasBox) {
  const mode = miniatureModeOf(box.embedPath.at(-1) ?? '')
  if (mode === 'none') return undefined
  if (mode === 'throws') throw new Error('miniature failed')
  const w = mode === 'tall' ? box.maxWidth : Math.min(box.maxWidth, 120)
  const h = mode === 'tall' ? box.maxHeight : Math.min(box.maxHeight, 80)
  return {
    nodes: [{ kind: 'shape' as const, bbox: { x: box.x, y: box.y, w, h }, radius: 3 }],
    w,
    h,
  }
}

/** The scene an input lays out as, with the seam tables it was drawn from and the measurer's calls. */
export function layoutOf(input: TypesetInput) {
  const seams = seamsFor(input.root, input.embeds)
  const base = createFakeMeasure()
  let calls = 0
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    calls += 1
    return base(text, font)
  }
  const options: MdastLayoutOptions = {
    measure,
    maxWidth: fromHex(input.width),
    fontFamily: 'sans-serif',
    theme: THEMES[input.theme],
    ...(input.fill === null ? {} : { textFill: input.fill }),
    references: referencesFor(seams, input.embeds),
    ...(input.embeds === 'full' ? { layoutEmbeddedCanvas: miniatureFor } : {}),
    highlightCode: (lang, value) => highlightFor(lang, value),
    renderMath: (value) => mathFor(value),
    renderDiagram: (lang, value) => diagramFor(lang, value),
    ...(input.syntax === null ? {} : { syntax: input.syntax }),
    ...(input.embedPath === undefined ? {} : { embedPath: input.embedPath }),
  }
  const scene = typesetMdastBlocks(input.root, options)
  return { scene, seams, calls: () => calls }
}

/** The canonical text of a scene. */
export function canonicalDump(scene: Scene): string {
  // The sign of a NaN is the engine's to choose (x86 arithmetic makes a negative one), so a NaN
  // is held as the canonical positive quiet NaN on both sides — at the number, never in a string.
  return dumpScene(scene, canonicalNanHex)
}

/** A text's length and FNV digest, as a large answer is held. */
export function digestOf(text: string): { n: number; h: number } {
  const fnv = new Fnv()
  fnv.text(text)
  return { n: text.length, h: fnv.state }
}

export function typesetAnswer(input: TypesetInput): TypesetRecord {
  const { scene, seams, calls } = layoutOf(input)
  // A `&str` cannot hold half a surrogate pair, so a scene that has one is not an answer the Rust
  // typesetter can give; the corpus must not reach it.
  if (holdsHalfAPair(scene)) throw new Error(`typeset-oracle: ${input.id} lays out half a pair`)
  const text = canonicalDump(scene)
  const answer = { ...input, seams, calls: calls() }
  if (!input.digest) return { ...answer, scene: text }
  return { ...answer, ...digestOf(text) }
}
