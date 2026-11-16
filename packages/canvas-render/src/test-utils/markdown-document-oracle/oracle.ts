import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { type FragmentAsk, type FragmentEntry, fragmentAskKey } from '../../fragment-ask.js'
import { layoutCommentBody } from '../../layout/comment-body.js'
import { layoutMdastBlocks } from '../../layout/markdown-body.js'
import { selectMarkdownSection } from '../../layout/nodes/mdast-section.js'
import { type ReferenceWire, referenceSeamsFromWire } from '../../references/wire.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../../theme/font-family.js'
import { MARKDOWN_THEME_DOCUMENT } from '../../theme/markdown-theme.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createFakeMeasure } from '../fake-measure.js'
import { digestOf } from '../typeset-oracle/oracle.js'
import { answerText } from '../wasm/answer-text.js'

/**
 * The recorded answers of a markdown DOCUMENT's layout on each surface that
 * lays one out (ADR-0054 step 7, S18a), taken while the TypeScript still
 * does, so the core's markdown entry is held to them after it is gone.
 *
 * A surface is the options its root hands the layout, restated here as data
 * because canvas-render cannot import the roots:
 *
 * - `daemon`: server-core's `composeMarkdownScene` under `wb_scene_render`
 *   (720px, the document theme, the MCP light appearance), with a `#Heading`
 *   part selected first as `canvas-render-svg.ts` does;
 * - `preview`: apps/web's `layoutMarkdownScene` behind the preview pane and a
 *   note's version history (the document theme, `style: 'document'`, the
 *   app theme, the fragment table its math and diagram seams answer from);
 * - `outline`: the same call behind the outline rail and a row's outline,
 *   handed nothing but a width;
 * - `thumbnail`: the same call behind a note row's picture, with references,
 *   theme and library but no fragments;
 * - `comment`: `layoutCommentBody` as `CommentBody.tsx` calls it.
 *
 * The measurer is `createFakeMeasure()`, which the core repeats bit for bit.
 * The scene is written as `scene_wire` writes it (`answerText`); a body whose
 * scene runs to megabytes is held as its length and FNV digest instead.
 */

export type Surface = 'daemon' | 'preview' | 'outline' | 'thumbnail' | 'comment'

/**
 * The recorded bodies past the markdown parser's bounds, by name: the core
 * draws each as its literal text (owner decision q81, D7a) where the
 * TypeScript drew remark's reading, so a replay holds them as a tolerated
 * class that must differ from the recording rather than equal it.
 */
export const PAST_THE_PARSER: ReadonlySet<string> = new Set([
  'quote 33 deep',
  'list 39 deep',
  'list 40 deep',
  '1024 delimiter runs',
  '1100 delimiter runs',
])

/** The body a record's id names: what follows its surface, less its variant. */
export const bodyName = (id: string): string => id.split('/').slice(1).join('/').split('#')[0] ?? ''

export interface MarkdownInput {
  readonly id: string
  readonly surface: Surface
  readonly body: string
  readonly maxWidth: number
  /** The app theme a web surface paints an embedded board in; the daemon's is light. */
  readonly mode?: 'light' | 'dark'
  /** The daemon's `style` argument; the web surfaces always draw `'document'`. */
  readonly style?: string
  /** The families the surface's `fontAvailable` answers yes for. */
  readonly fonts?: readonly string[]
  /** The meta line's references, handed as the surface's bundle. */
  readonly references?: true
  /** The meta line's fragment table, or an empty one. */
  readonly fragments?: 'full' | 'empty'
  /** The meta line's tag library. */
  readonly library?: true
  /** The daemon's `#Heading` part. */
  readonly section?: string
  readonly density?: 'comfortable' | 'compact'
  /** Hold the answer as a digest rather than as text; set by the recorder past `SCENE_TEXT_LIMIT`. */
  readonly digest?: true
}

/** A section that names no heading answers no scene: the daemon refuses the render. */
type Answer =
  | { readonly scene: string; readonly asked?: readonly FragmentAsk[] }
  | { readonly n: number; readonly h: number; readonly asked?: readonly FragmentAsk[] }
  | { readonly refused: 'section-not-found' }

export type MarkdownRecord = MarkdownInput & Answer

/**
 * What every record of a file may point at, written once as the file's first
 * line: one copy of the wire rather than one per record that hands it.
 */
export interface MarkdownTables {
  readonly references: ReferenceWire
  readonly fragments: readonly FragmentEntry[]
  readonly library: TagLibrary
}

export interface MarkdownMeta extends MarkdownTables {
  readonly kind: 'meta'
}

/** A fragment seam answered from the table, noting each source it lacked once, in the order asked. */
function tabled(fragments: readonly FragmentEntry[], asked: Map<string, FragmentAsk>) {
  const rendered = new Map(fragments)
  const answer = (ask: FragmentAsk) => {
    const key = fragmentAskKey(ask)
    const found = rendered.get(key)
    if (found === undefined && !asked.has(key)) asked.set(key, ask)
    return found
  }
  return {
    renderMath: (value: string) => answer({ kind: 'math', value }),
    renderDiagram: (lang: string, value: string) => answer({ kind: 'diagram', lang, value }),
  }
}

function documentOptions(
  input: MarkdownInput,
  tables: MarkdownTables,
  asked: Map<string, FragmentAsk>,
): Parameters<typeof layoutMdastBlocks>[1] {
  const fonts = new Set(input.fonts ?? [])
  const references =
    input.references === true ? referenceSeamsFromWire(tables.references) : undefined
  const fragments = input.fragments === 'full' ? tables.fragments : []
  return {
    measure: createFakeMeasure(),
    maxWidth: input.maxWidth,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    theme: MARKDOWN_THEME_DOCUMENT,
    canvasAppearance: createSpatialTheme({ mode: input.mode ?? 'light' }),
    ...(input.surface === 'daemon'
      ? input.style === undefined
        ? {}
        : { style: input.style }
      : { style: 'document' }),
    ...(input.fonts === undefined ? {} : { fontAvailable: (family: string) => fonts.has(family) }),
    ...(references === undefined ? {} : { references }),
    ...(input.fragments === undefined ? {} : tabled(fragments, asked)),
    ...(input.library === true ? { tagLibrary: tables.library } : {}),
  }
}

function layoutOf(
  input: MarkdownInput,
  tables: MarkdownTables,
  asked: Map<string, FragmentAsk>,
): Scene | undefined {
  if (input.surface === 'comment') {
    return layoutCommentBody(input.body, {
      measure: createFakeMeasure(),
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      maxWidth: input.maxWidth,
      density: input.density ?? 'comfortable',
    })
  }
  const options = documentOptions(input, tables, asked)
  const whole = resolveReferences(parseMarkdownBody(input.body), options.references?.resolveAlias)
  const root = input.section === undefined ? whole : selectMarkdownSection(whole, input.section)
  return root === undefined ? undefined : layoutMdastBlocks(root, options)
}

/**
 * The longest scene held as text. Past it a record holds the scene's length
 * and digest, which still pins every byte but names no first difference; the
 * repository's long documents and the boundary bodies are the ones over it.
 */
const SCENE_TEXT_LIMIT = 48_000

/** `value` with every object's keys in code-unit order. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([key, item]) => [key, sortedKeys(item)]))
}

/**
 * The length and FNV digest of a scene spelled as `answerText` spells it with
 * every object's keys sorted. A digest record's own `n` and `h` are taken
 * over the TypeScript's key order, which is the order its objects were BUILT
 * in and differs between two objects of one kind (a run's `strong` and
 * `emphasis` follow the nesting they came from), so no writer of the core's
 * answer can repeat it; sorted, the text is a function of the scene's values
 * alone.
 */
export function sortedSceneDigest(scene: Scene): { readonly n: number; readonly h: number } {
  const text = answerText(sortedKeys(scene))
  if (text === undefined) throw new Error('markdown-document-oracle: a non-finite number')
  return digestOf(text)
}

/** `sortedSceneDigest` of an input's scene, or undefined for a section that names no heading. */
export function sortedDigest(
  input: MarkdownInput,
  tables: MarkdownTables,
): { readonly n: number; readonly h: number } | undefined {
  const scene = layoutOf(input, tables, new Map())
  return scene === undefined ? undefined : sortedSceneDigest(scene)
}

export function markdownAnswer(input: MarkdownInput, tables: MarkdownTables): MarkdownRecord {
  const asked = new Map<string, FragmentAsk>()
  const scene = layoutOf(input, tables, asked)
  if (scene === undefined) return { ...input, refused: 'section-not-found' }
  const text = answerText(scene)
  if (text === undefined)
    throw new Error(`markdown-document-oracle: ${input.id} drew a non-finite number`)
  const fragments = input.fragments === undefined ? {} : { asked: [...asked.values()] }
  if (input.digest === true || text.length > SCENE_TEXT_LIMIT) {
    return { ...input, digest: true, ...digestOf(text), ...fragments }
  }
  return { ...input, scene: text, ...fragments }
}

/** The input half of a record, as the replay hands it back. */
export function inputOf(record: MarkdownRecord): MarkdownInput {
  const {
    scene: _s,
    n: _n,
    h: _h,
    asked: _a,
    refused: _r,
    ...input
  } = record as MarkdownRecord & {
    scene?: unknown
    n?: unknown
    h?: unknown
    asked?: unknown
    refused?: unknown
  }
  return input
}
