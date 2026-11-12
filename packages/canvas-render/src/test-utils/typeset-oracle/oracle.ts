import type {
  MdastFlowContent,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { expandEmojiShortcodes } from '@kamiazya/whiteboard-plugin-visual/emoji/shortcode'
import { iconShortcodeRanges } from '@kamiazya/whiteboard-plugin-visual/icons/shortcode'
import { typesetMdastBlocks } from '../../layout/nodes/mdast-blocks.js'
import type { MdastLayoutOptions } from '../../layout/nodes/mdast-layout-options.js'
import type { FontDescriptor, TextMetrics } from '../../measure.js'
import type { ReferenceSeams } from '../../references/seams.js'
import {
  MARKDOWN_THEME_COMPACT,
  MARKDOWN_THEME_DOCUMENT,
  MARKDOWN_THEME_NODE,
  type MarkdownTheme,
} from '../../theme/markdown-theme.js'
import { Parser } from '../../vendor/budoux/parser.js'
import { createFakeMeasure } from '../fake-measure.js'
import { dumpScene, f64Hex } from '../render-oracle/scene-dump.js'

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
export interface SeamTables {
  /** An icon range is in UTF-16 units, as the host's answer is. */
  readonly icons: Readonly<Record<string, readonly { from: number; to: number; name: string }[]>>
  readonly emoji: Readonly<Record<string, string>>
  readonly titles: Readonly<Record<string, string | null>>
  readonly embeds: Readonly<Record<string, string | null>>
  readonly pending: readonly string[]
  readonly images: Readonly<
    Record<string, { href: string; width?: number; height?: number } | null>
  >
}

export interface TypesetInput {
  readonly id: string
  readonly root: MdastRoot
  /** The wrap width's IEEE bits, since JSON cannot hold NaN or infinity. */
  readonly width: string
  readonly theme: ThemeName
  readonly fill: string | null
  /** Hold the answer as a digest rather than as text. */
  readonly digest: boolean
}

export type TypesetRecord = TypesetInput & {
  readonly seams: SeamTables
  readonly calls: number
} & ({ readonly scene: string } | { readonly n: number; readonly h: number })

export interface RecordMeta {
  readonly kind: 'meta'
  readonly seed: number
  readonly generated: number
  /** Inputs left out because BudouX cut between the halves of a surrogate pair. */
  readonly pairBoundary: number
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
const embedNameOf = (id: string): string | null =>
  hashOf(`e${id}`) % 3 === 0 ? null : `Doc ${id.slice(0, 6)}`
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

const inlinesOf = (root: MdastRoot): readonly Inline[] =>
  root.children.flatMap((block) =>
    block.type === 'paragraph' || block.type === 'heading' ? block.children : [],
  )

/** Every question the layout can put to its host about this tree, answered. */
export function seamsFor(root: MdastRoot): SeamTables {
  const icons: Record<string, { from: number; to: number; name: string }[]> = {}
  const emoji: Record<string, string> = {}
  const titles: Record<string, string | null> = {}
  const embeds: Record<string, string | null> = {}
  const pending: string[] = []
  const images: Record<string, SeamTables['images'][string]> = {}
  const ask = (id: string) => {
    titles[id] = titleOf(id)
    embeds[id] = embedNameOf(id)
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
  return { icons, emoji, titles, embeds, pending: [...new Set(pending)], images }
}

/** A paragraph that is only an embed is a block embed, which a later slice carries. */
export const isBlockEmbed = (block: MdastFlowContent): boolean =>
  block.type === 'paragraph' && block.children.length === 1 && block.children[0]?.type === 'embed'

function referencesFor(seams: SeamTables): ReferenceSeams {
  const pending = new Set(seams.pending)
  return {
    resolveAlias: () => null,
    resolveTitle: (id) => seams.titles[id] ?? undefined,
    resolveEmbed: (id) => {
      const title = seams.embeds[id]
      return title === null || title === undefined
        ? undefined
        : { title, root: { type: 'root', children: [] } }
    },
    isLoading: (id) => pending.has(id),
    resolveReference: (url) => {
      const image = seams.images[url]
      return image === null || image === undefined ? undefined : { image }
    },
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

class Fnv {
  state = 0x811c_9dc5
  text(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      this.state = Math.imul(this.state ^ text.charCodeAt(i), 16_777_619) >>> 0
    }
  }
}

/**
 * BudouX reads UTF-16 units and can name a phrase boundary inside a surrogate pair, which the
 * wrapper may then break at, leaving half an emoji in a run. The Rust typesetter cannot hold half a
 * pair in a `&str` and does not take such a boundary, so an input that reaches one is not one the
 * two can be held to: it is left out of the recording, and counted.
 */
let cutAPair = false
const parsePhrases = Parser.prototype.parse
Parser.prototype.parse = function parse(this: Parser, text: string) {
  const phrases = parsePhrases.call(this, text)
  if (phrases.some((phrase) => /[\ud800-\udbff]$/.test(phrase))) cutAPair = true
  return phrases
}

export function typesetAnswer(input: TypesetInput): TypesetRecord | null {
  const seams = seamsFor(input.root)
  if (input.root.children.some(isBlockEmbed)) {
    throw new Error(`typeset-oracle: ${input.id} holds a block embed`)
  }
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
    references: referencesFor(seams),
  }
  cutAPair = false
  const scene = typesetMdastBlocks(input.root, options)
  if (cutAPair) return null
  const text = dumpScene(scene)
  // A `&str` cannot hold half a surrogate pair, so a scene that has one is not an answer the Rust
  // typesetter can give; the corpus must not reach it.
  if (LONE_SURROGATE.test(text)) throw new Error(`typeset-oracle: ${input.id} lays out half a pair`)
  const answer = { ...input, seams, calls }
  if (!input.digest) return { ...answer, scene: text }
  const fnv = new Fnv()
  fnv.text(text)
  return { ...answer, n: text.length, h: fnv.state }
}
