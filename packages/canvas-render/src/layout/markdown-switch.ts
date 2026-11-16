import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { highlightCode } from '../highlight/lowlight.js'
import type {
  MarkdownLayoutAnswer,
  MarkdownLayoutSkip,
  MarkdownNoteRequest,
} from '../markdown-core.js'
import { type MeasureText, measureSpecOf } from '../measure.js'
import type { ReferenceSeams } from '../references/seams.js'
import { wireOfSeams } from '../references/wire.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { MARKDOWN_THEME_DOCUMENT } from '../theme/markdown-theme.js'
import { createSpatialTheme, type SpatialThemeMode } from '../theme/spatial-theme.js'
import { firstDifference, hasData, styleOptions, valueAt } from './canvas-switch.js'
import type { LayoutCore } from './edges/layout-core.js'
import type { SpatialRenderStyle } from './layout-options.js'
import { layoutMdastBlocks } from './markdown-body.js'
import { type FragmentAsk, type FragmentEntry, fragmentAskKey } from './nodes/fragment-ask.js'
import type { RenderedSvgFragment } from './nodes/mdast-layout-options.js'
import { selectMarkdownSection } from './nodes/mdast-section.js'

// A markdown note's switch (ADR-0054 step 7, S18c): which notes the Rust
// core's markdown entry can be handed, and who answers one under `ts`,
// `differential` and `rust`.

/**
 * A markdown DOCUMENT laid out as a page: the document theme, the bundled
 * family, every option data a request can carry. What a surface may vary is
 * what a board the note embeds is drawn with, and what the note points at.
 */
export interface MarkdownDocumentOptions {
  readonly measure: MeasureText
  readonly maxWidth: number
  /** The bundled theme a board the note embeds is painted in; absent, light. */
  readonly mode?: SpatialThemeMode
  /** Which look an embedded board is drawn in (`layoutMdastBlocks`' `style`); absent, clean. */
  readonly style?: SpatialRenderStyle
  /** Whether a family an embedded board's theme names can be measured here. */
  readonly fontAvailable?: (family: string) => boolean
  /** The workspace's tag library, so an embedded board is coloured by intent. */
  readonly tagLibrary?: TagLibrary
  /** What the note's links and embeds resolve through; absent, nothing resolves. */
  readonly references?: ReferenceSeams
  /**
   * The rendered math blocks and diagram fences by `fragmentAskKey`; a source
   * the table lacks is drawn as its fallback and handed to `onFragmentsAsked`
   * once each, in the order asked.
   */
  readonly fragments?: readonly FragmentEntry[]
  readonly onFragmentsAsked?: (asks: readonly FragmentAsk[]) => void
  /** Lay out only the section under this heading (`#Heading`). */
  readonly section?: string
  /** The Rust core and its switch, as a canvas layout takes it. */
  readonly core?: LayoutCore
}

/** A note's request the core can be handed, or why the options cannot be one. */
export type MarkdownLayoutAsk = MarkdownNoteRequest | { readonly skip: MarkdownLayoutSkip }

const usesTable = (options: MarkdownDocumentOptions): boolean =>
  options.fragments !== undefined || options.onFragmentsAsked !== undefined

/**
 * `body` and `options` as a request the core answers exactly as the
 * TypeScript would, or the first reason they cannot be one: a measurer
 * nobody named, or a reference bundle not rebuilt from a wire or one whose
 * extras carry content.
 */
export function markdownLayoutRequest(
  body: string,
  options: MarkdownDocumentOptions,
): MarkdownLayoutAsk {
  const measure = measureSpecOf(options.measure)
  if (measure === undefined) return { skip: 'measure' }
  const wire = options.references === undefined ? undefined : wireOfSeams(options.references)
  if (options.references !== undefined && wire === undefined) return { skip: 'references' }
  if (wire !== undefined && !wire.extras.every(([, extra]) => hasData(extra))) {
    return { skip: 'reference-content' }
  }
  const { tagLibrary, section } = options
  return {
    kind: 'markdown',
    body,
    maxWidth: options.maxWidth,
    measure,
    mode: options.mode ?? 'light',
    ...styleOptions(options),
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
    ...(wire === undefined ? {} : { references: wire }),
    ...(usesTable(options) ? { fragments: options.fragments ?? [] } : {}),
    ...(section === undefined ? {} : { section }),
  }
}

/** The fragment seams answered from the table, and what it lacked, once each in the order asked. */
function fragmentSeams(options: MarkdownDocumentOptions) {
  const rendered = new Map(options.fragments ?? [])
  const asked = new Map<string, FragmentAsk>()
  const answer = (ask: FragmentAsk): RenderedSvgFragment | undefined => {
    const key = fragmentAskKey(ask)
    const found = rendered.get(key)
    if (found === undefined && !asked.has(key)) asked.set(key, ask)
    return found
  }
  const seams = {
    renderMath: (value: string) => answer({ kind: 'math', value }),
    renderDiagram: (lang: string, value: string) => answer({ kind: 'diagram', lang, value }),
  }
  return { seams, asked: () => [...asked.values()] }
}

/** A note laid out by the TypeScript, and the fragment sources it asked for when it was handed a table. */
interface TsNote {
  readonly scene: Scene | undefined
  readonly asked?: readonly FragmentAsk[]
}

function layoutTs(
  body: string,
  options: MarkdownDocumentOptions,
  core: LayoutCore | undefined,
): TsNote {
  const { references, section, style, fontAvailable, tagLibrary } = options
  const whole = resolveReferences(parseMarkdownBody(body), references?.resolveAlias)
  const root = section === undefined ? whole : selectMarkdownSection(whole, section)
  if (root === undefined) return { scene: undefined }
  const table = usesTable(options) ? fragmentSeams(options) : undefined
  const scene = layoutMdastBlocks(root, {
    measure: options.measure,
    maxWidth: options.maxWidth,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    theme: MARKDOWN_THEME_DOCUMENT,
    canvasAppearance: createSpatialTheme({ mode: options.mode ?? 'light' }),
    ...(style === undefined ? {} : { style }),
    ...(fontAvailable === undefined ? {} : { fontAvailable }),
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
    ...(references === undefined ? {} : { references }),
    ...(core === undefined ? {} : { core }),
    ...table?.seams,
  })
  return table === undefined ? { scene } : { scene, asked: table.asked() }
}

/** What a note's caller is answered, its fragment listener told what the table lacked. */
function answered(laid: TsNote, options: MarkdownDocumentOptions): Scene | undefined {
  if (laid.asked !== undefined && laid.asked.length > 0) options.onFragmentsAsked?.(laid.asked)
  return laid.scene
}

/**
 * A markdown DOCUMENT laid out as `options.core` says, or `undefined` for a
 * `section` it holds no heading for: by the TypeScript (`layoutMdastBlocks`
 * over the parsed, resolved body) when no core or no markdown core is given,
 * its switch reads `ts`, or the request is one the core cannot be handed;
 * under `rust` by the core's markdown entry; under `differential` by the
 * TypeScript with the core run beside it and any difference in the scene or
 * the fragments asked reported. What the gate skips and what the core
 * declines (each reported by class), and a core that throws (reported), the
 * TypeScript answers, handed the core for a board the note embeds as before.
 *
 * Degradations are not reported: the TypeScript reports none for a note, so
 * a core's are not compared and not forwarded.
 */
export function layoutMarkdownDocument(
  body: string,
  options: MarkdownDocumentOptions,
): Scene | undefined {
  const core = options.core
  const impl = core?.impl.layoutMarkdown ?? 'ts'
  const fallback = () => answered(layoutTs(body, options, core), options)
  if (core?.markdown === undefined || impl === 'ts') return fallback()
  const request = markdownLayoutRequest(body, options)
  if ('skip' in request) {
    core.onMismatch?.({ fn: 'layoutMarkdown', kind: 'skipped', reason: request.skip })
    return fallback()
  }
  let answer: MarkdownLayoutAnswer
  try {
    answer = core.markdown.layoutMarkdown(request, highlightCode, options.measure)
  } catch (err) {
    core.onMismatch?.({ fn: 'layoutMarkdown', kind: 'refused', err, repro: request })
    return fallback()
  }
  if ('declined' in answer) {
    core.onMismatch?.({ fn: 'layoutMarkdown', kind: 'declined', reason: answer.declined })
    return fallback()
  }
  const rust: TsNote =
    'missing' in answer
      ? { scene: undefined }
      : {
          scene: answer.scene,
          ...(answer.fragmentsAsked === undefined ? {} : { asked: answer.fragmentsAsked }),
        }
  if (impl === 'rust') return answered(rust, options)
  // The TypeScript beside the core is the TypeScript alone: an embedded
  // board handed the core would report its own gate's skips into the count.
  const ts = layoutTs(body, options, undefined)
  const comparable = (note: TsNote) => ({ scene: note.scene ?? 'missing', asked: note.asked ?? [] })
  const [tsValue, rustValue] = [comparable(ts), comparable(rust)]
  const at = firstDifference(tsValue, rustValue)
  if (at !== undefined) {
    core.onMismatch?.({
      fn: 'layoutMarkdown',
      kind: 'differs',
      at,
      ts: valueAt(tsValue, at),
      rust: valueAt(rustValue, at),
      repro: request,
    })
  }
  return answered(ts, options)
}
