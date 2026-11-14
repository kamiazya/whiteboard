import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { type TagLibrary, VISUAL_THEMES } from '@kamiazya/whiteboard-plugin-visual'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { RenderContribution, Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import type {
  SpatialContentCache,
  SpatialLayoutDegradation,
  SpatialLayoutOptions,
} from '../../layout/layout-options.js'
import type { FittedBlocks } from '../../layout/nodes/mdast-blocks.js'
import {
  layoutSpatialCanvasWithAnchors,
  layoutSpatialEdges,
  naturalNodeContentSize,
} from '../../layout/spatial-canvas.js'
import type { FontDescriptor, TextMetrics } from '../../measure.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { anchorRow } from '../compose-edges-oracle/oracle.js'
import { overridesWire } from '../compose-edges-oracle/wire.js'
import { createFakeMeasure } from '../fake-measure.js'
import { dumpScene, f64Hex } from '../render-oracle/scene-dump.js'
import {
  BOXY_THEME_ID,
  type Board,
  boards,
  type CaseSpec,
  CHILD_ID,
  caseSpecs,
  REFERENCES,
  resolveAlias,
  TAG_LIBRARY,
} from './corpus.js'
import { type CanvasWire, canvasWire } from './wire.js'

/**
 * The recorded answers of the composer's walk over a whole canvas
 * (`layoutSpatialCanvasWithAnchors`, `layoutSpatialEdges` and
 * `naturalNodeContentSize` in `layout/spatial-canvas.ts`), under the options a
 * caller hands a layout.
 *
 * What the Rust port takes as a seam is data here: each body as parsed, and
 * what the overlays (proposals, the legend) drew over the top-level canvas —
 * the nodes after what the walk itself drew, and the legend. No board carries
 * a thread: the comment layer is the compose-comments recording's. Every double is
 * the hex of its IEEE bits (a NaN the canonical one), and `calls` counts what
 * the measurer was asked.
 */

/** `f64Hex`, with every NaN written as the positive quiet NaN `f64::NAN` is. */
export const hex = (value: number): string =>
  Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value)

export const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const dump = (nodes: readonly SceneNode[]): string => dumpScene({ nodes: [...nodes] }, hex)

const sketch = VISUAL_THEMES.sketch
if (sketch === undefined)
  throw new Error('compose-canvas-oracle: the bundled sketch theme is missing')

/** The sketch tokens with a default silhouette, which no bundled theme declares. */
const BOXY: ThemeTokens = {
  ...sketch,
  defaults: { ...sketch.defaults, nodeShape: 'visual.diamond' },
}

/** A contribution that registers one theme and reads nothing. */
export const TEST_CONTRIBUTION: RenderContribution = { namespace: 'test', themes: { boxy: BOXY } }

/** The theme table the layouts resolve against, by namespaced id. */
export const THEMES: readonly (readonly [string, ThemeTokens])[] = [
  ...Object.entries(VISUAL_THEMES).map(([name, tokens]) => [`visual.${name}`, tokens] as const),
  [BOXY_THEME_ID, BOXY],
]

interface MetaRecord {
  readonly kind: 'meta'
  readonly themes: typeof THEMES
  readonly library: TagLibrary
  /** Each body as parsed with its references resolved. */
  readonly bodies: Readonly<Record<string, MdastRoot>>
  /** The canvas each reference resolves to, as the replay reads a canvas. */
  readonly references: Readonly<Record<string, CanvasWire>>
  /** The document a body's `![[child]]` names: its title and canvas. */
  readonly embeds: Readonly<Record<string, { title: string; canvas: CanvasWire }>>
}

export interface Event {
  readonly kind: string
  readonly nodeId: string
  readonly detail: string
}

interface CanvasAnswer {
  readonly scene: string
  /** What the overlays drew: everything after the first `from` nodes. */
  readonly overlay: { readonly from: number; readonly nodes: readonly SceneNode[] }
  readonly legend: Scene['legend'] | null
  readonly anchors: readonly (readonly (string | null)[])[]
  readonly events: readonly Event[]
  /** What the walk asked the measurer, the overlays' own questions not counted. */
  readonly calls: number
  /** The keys the content cache was asked, when the case hands one over. */
  readonly asked?: readonly string[]
}

interface EntryAnswer {
  readonly scene: string
  readonly events: readonly Event[]
  readonly calls: number
}

interface CaseRecord extends Omit<CaseSpec, 'geometry' | 'overrides'> {
  readonly kind: 'case'
  readonly id: string
  readonly canvas: CanvasWire
  readonly geometry?: readonly string[]
  readonly overrides?: ReturnType<typeof overridesWire>['overrides']
  readonly answer: {
    readonly canvas: CanvasAnswer
    readonly edges: EntryAnswer
    /** Each node's natural size, `[id, w, h]`, then the measurer calls over them all. */
    readonly natural: readonly (readonly string[])[]
    readonly naturalCalls: number
    readonly naturalEvents: readonly Event[]
    readonly naturalAsked?: readonly string[]
  }
}

export type ComposeCanvasRecord = MetaRecord | CaseRecord

const detailOf = (event: SpatialLayoutDegradation): string => {
  switch (event.kind) {
    case 'unknown-theme':
      return event.theme
    case 'font-missing':
      return event.family
    case 'unknown-node-kind':
      return event.type
    case 'unsupported-background-style':
      return event.style
    default:
      return ''
  }
}

export const eventOf = (e: SpatialLayoutDegradation): Event => ({
  kind: e.kind,
  nodeId: 'nodeId' in e ? e.nodeId : '',
  detail: detailOf(e),
})

const appearanceOf = (spec: CaseSpec) => {
  if (spec.appearance === 'light') return createSpatialTheme({ mode: 'light' })
  const dark = createSpatialTheme({ mode: 'dark' })
  return spec.appearance === 'dark' ? dark : { ...dark, mode: undefined }
}

const fontsOf = (spec: CaseSpec) =>
  spec.fonts === 'default' ? {} : { fontAvailable: () => spec.fonts === 'all' }

/** A run's counters: the measurer's calls, the degradations reported and the cache keys asked. */
interface Run {
  calls: number
  readonly events: SpatialLayoutDegradation[]
  readonly asked: string[]
}

/** A content cache that keeps what it is handed and notes every key it is asked. */
function recordingCache(run: Run): SpatialContentCache {
  const entries = new Map<string, FittedBlocks>()
  return {
    get: (key) => {
      run.asked.push(key)
      return entries.get(key)
    },
    set: (key, value) => {
      entries.set(key, value)
    },
  }
}

/** What a caller hands every entry point for a case, counting into `run`. */
function optionsOf(spec: CaseSpec, run: Run): SpatialLayoutOptions {
  const base = createFakeMeasure()
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    run.calls += 1
    return base(text, font)
  }
  const [paddingPx, labelFontSizePx, minContentWidthPx] = (spec.geometry ?? []) as number[]
  return {
    measure,
    appearance: appearanceOf(spec),
    renderContributions: [visualRenderContribution, TEST_CONTRIBUTION],
    onDegrade: (event) => run.events.push(event),
    ...fontsOf(spec),
    ...(spec.style === undefined ? {} : { style: spec.style }),
    ...(spec.geometry === undefined
      ? {}
      : { geometry: { paddingPx, labelFontSizePx, minContentWidthPx } as never }),
    ...(spec.locked === undefined ? {} : { lockedNodeIds: spec.locked }),
    ...(spec.suppressed === undefined ? {} : { suppressedBodyNodeIds: spec.suppressed }),
    ...(spec.library === true ? { tagLibrary: TAG_LIBRARY } : {}),
    ...(spec.overrides === undefined ? {} : { edgeSideOverrides: new Map(spec.overrides) }),
    ...(spec.embedPath === undefined ? {} : { embedPath: spec.embedPath }),
    ...(spec.cache === true ? { contentCache: recordingCache(run) } : {}),
    resolveAlias,
    resolveReference: (ref) => {
      const nested = REFERENCES[ref]
      return nested === undefined ? undefined : { canvas: nested.canvas }
    },
    expandFileNode: () => true,
    resolveEmbed: (id) => (id === CHILD_ID ? childEmbed() : undefined),
  }
}

const childEmbed = () => {
  const child = REFERENCES['boards/child.canvas']
  if (child === undefined) throw new Error('compose-canvas-oracle: no child canvas')
  return child
}

const fresh = (): Run => ({ calls: 0, events: [], asked: [] })

/** The whole layout, and where the overlays begin in it. */
function canvasAnswer(spec: CaseSpec, board: Board): CanvasAnswer {
  const run = fresh()
  const { scene, anchors } = layoutSpatialCanvasWithAnchors(board.canvas, optionsOf(spec, run))
  const walk = fresh()
  const bare = layoutSpatialCanvasWithAnchors(board.canvas, {
    ...optionsOf(spec, walk),
    commentLayer: false,
  }).scene.nodes
  const from = bare.length
  if (dump(scene.nodes.slice(0, from)) !== dump(bare)) {
    throw new Error(`compose-canvas-oracle: ${board.name}'s overlays moved what the walk drew`)
  }
  return {
    scene: dump(scene.nodes),
    overlay: { from, nodes: viaJson(scene.nodes.slice(from)) },
    legend: scene.legend === undefined ? null : viaJson(scene.legend),
    anchors: [...anchors].map(([id, pair]) => anchorRow(id, pair)),
    events: run.events.map(eventOf),
    calls: walk.calls,
    ...(spec.cache === true ? { asked: [...run.asked] } : {}),
  }
}

function edgesAnswer(spec: CaseSpec, board: Board): EntryAnswer {
  const run = fresh()
  const content = layoutSpatialEdges(board.canvas, optionsOf(spec, run))
  return { scene: dump(content), events: run.events.map(eventOf), calls: run.calls }
}

function naturalAnswer(spec: CaseSpec, board: Board) {
  const run = fresh()
  const options = optionsOf(spec, run)
  const natural = board.canvas.nodes.map((node) => {
    const { w, h } = naturalNodeContentSize(node, options)
    return [node.id, hex(w), hex(h)]
  })
  return {
    natural,
    naturalCalls: run.calls,
    naturalEvents: run.events.map(eventOf),
    ...(spec.cache === true ? { naturalAsked: [...run.asked] } : {}),
  }
}

function boardNamed(name: string): Board {
  const board = boards().find((b) => b.name === name)
  if (board === undefined) throw new Error(`compose-canvas-oracle: no board ${name}`)
  return board
}

function caseRecord(spec: CaseSpec, index: number): CaseRecord {
  const board = boardNamed(spec.board)
  const { geometry, overrides, ...rest } = spec
  const overridden = overridesWire(
    { name: board.name, canvas: board.canvas, shapes: {}, ...(overrides ? { overrides } : {}) },
    hex,
  )
  return {
    kind: 'case',
    id: `${index}-${spec.board}`,
    ...rest,
    canvas: canvasWire(board.canvas, hex),
    ...(geometry === undefined ? {} : { geometry: geometry.map(hex) }),
    ...overridden,
    answer: {
      canvas: canvasAnswer(spec, board),
      edges: edgesAnswer(spec, board),
      ...naturalAnswer(spec, board),
    },
  }
}

export const bodiesOf = (canvases: readonly SpatialCanvas[]): Record<string, MdastRoot> => {
  const texts = canvases.flatMap((canvas) =>
    canvas.nodes.flatMap((node) =>
      node.resource?.content === undefined ? [] : [node.resource.content],
    ),
  )
  return Object.fromEntries(
    texts.map((body) => [body, viaJson(resolveReferences(parseMarkdownBody(body), resolveAlias))]),
  )
}

/** Every record, in file order: the meta line, then each case. */
export function composeCanvasRecords(): readonly ComposeCanvasRecord[] {
  const meta: MetaRecord = {
    kind: 'meta',
    themes: THEMES,
    library: TAG_LIBRARY,
    bodies: bodiesOf([
      ...boards().map((board) => board.canvas),
      ...Object.values(REFERENCES).map((nested) => nested.canvas),
    ]),
    references: Object.fromEntries(
      Object.entries(REFERENCES).map(([ref, nested]) => [ref, canvasWire(nested.canvas, hex)]),
    ),
    embeds: {
      [CHILD_ID]: { title: childEmbed().title, canvas: canvasWire(childEmbed().canvas, hex) },
    },
  }
  return [meta, ...caseSpecs().map((spec, index) => caseRecord(spec, index))]
}
