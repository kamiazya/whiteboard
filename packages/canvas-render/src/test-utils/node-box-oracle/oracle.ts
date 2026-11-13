import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { VISUAL_THEMES } from '@kamiazya/whiteboard-plugin-visual'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import type { ResolvedLayoutOptions } from '../../layout/layout-options.js'
import {
  chromeShape,
  chromeWithFit,
  contentWidth,
  fitSceneInNode,
  labelOf,
  labelRuns,
  nodeContentBounds,
  placeAboveNode,
  placeInNode,
} from '../../layout/node-box.js'
import { BUNDLED_SHAPE_TABLE } from '../../layout/nodes/node-outline.js'
import { seedFromId } from '../../layout/seed.js'
import { translateScene } from '../../layout/translate-scene.js'
import type { FontDescriptor, TextMetrics } from '../../measure.js'
import type { ResolvedReference } from '../../references/resolved.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createThemedAppearance } from '../../theme/theme-asset.js'
import { createFakeMeasure } from '../fake-measure.js'
import { dumpScene, f64Hex } from '../render-oracle/scene-dump.js'
import {
  type CaseSpec,
  caseSpecs,
  contentScene,
  contents,
  RESOURCES,
  type ResolvedWire,
} from './corpus.js'

/**
 * The recorded answers of the node-box primitives (`layout/node-box.ts`) and the
 * two scene transforms they stand on, `translateScene` and `seedFromId`.
 *
 * A `case` record holds a node, the options a composer hands the box (theme,
 * geometry, fit, the silhouette the canvas resolved, a file node's resolution),
 * the `visual.text/v0` alignment the node carries, read by the plugin's own
 * reader, and every answer: the content bounds and width, the chrome and the
 * chrome carrying a fit, the label and its runs above and inside, a probe
 * label's runs, and a named content scene placed in the node, above it and
 * fitted to it. Every double is the hex of its IEEE bits (a NaN the canonical one), and
 * `calls` counts what the measurer was asked.
 */

const sketch = VISUAL_THEMES.sketch
if (sketch === undefined) throw new Error('node-box-oracle: the bundled sketch theme is missing')

/** `f64Hex`, with every NaN written as the positive quiet NaN `f64::NAN` is. */
const hex = (value: number): string => (Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value))

const dump = (nodes: readonly SceneNode[]): string => dumpScene({ nodes: [...nodes] }, hex)

class Fnv {
  state = 0x811c_9dc5
  text(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      this.state = Math.imul(this.state ^ text.charCodeAt(i), 16_777_619) >>> 0
    }
  }
}

const digest = (text: string): { n: number; h: number } => {
  const fnv = new Fnv()
  fnv.text(text)
  return { n: text.length, h: fnv.state }
}

interface MetaRecord {
  readonly kind: 'meta'
  /** The sketch theme's tokens, which the replay reads into its own types. */
  readonly sketch: unknown
  /** The content scenes a case places, by name, as plain JSON. */
  readonly contents: Readonly<Record<string, readonly SceneNode[]>>
}

interface SeedRecord {
  readonly kind: 'seed'
  readonly ids: readonly string[]
  readonly seeds: readonly number[]
}

interface TranslateRecord {
  readonly kind: 'translate'
  readonly content: string
  readonly dx: string
  readonly dy: string
  readonly n: number
  readonly h: number
}

/** A node as data: its box as IEEE bits, the rest as JSON. */
interface NodeWire {
  readonly id: string
  readonly box: readonly string[]
  readonly color?: string
  readonly resource?: SpatialNode['resource']
  readonly label?: string
}

interface CaseRecord {
  readonly kind: 'case'
  readonly id: string
  readonly node: NodeWire
  readonly theme: CaseSpec['theme']
  readonly fitToBox: boolean
  /** The alignment the node's `visual.text/v0` payload names, none for no payload. */
  readonly align: CaseSpec['align']
  readonly shape: string | null
  readonly geometry: readonly string[]
  readonly resolved: ResolvedWire
  readonly probe: string
  readonly content: string
  readonly answer: CaseAnswer
}

interface CaseAnswer {
  readonly bounds: readonly string[]
  readonly width: string
  readonly chrome: string
  readonly fitted: string
  readonly label: string | null
  readonly above: string
  readonly inside: string
  readonly probe: string
  readonly placed: { n: number; h: number }
  readonly lifted: { n: number; h: number }
  readonly fit: { n: number; h: number; truncated: boolean; overflows: boolean } | null
  readonly calls: number
}

export type NodeBoxRecord = MetaRecord | SeedRecord | TranslateRecord | CaseRecord

const fromHex = (text: string): number => {
  const view = new DataView(new ArrayBuffer(8))
  view.setUint32(0, Number.parseInt(text.slice(0, 8), 16))
  view.setUint32(4, Number.parseInt(text.slice(8), 16))
  return view.getFloat64(0)
}

/** The node carrying the `visual.text/v0` payload a case names, which the plugin's own reader reads. */
const withAlign = (node: SpatialNode, align: CaseRecord['align']): SpatialNode =>
  align === null ? node : { ...node, facets: { 'visual.text/v0': { align } } }

function nodeOf(wire: NodeWire): SpatialNode {
  const [x, y, width, height] = wire.box.map(fromHex) as [number, number, number, number]
  return {
    id: wire.id,
    x,
    y,
    width,
    height,
    ...(wire.color === undefined ? {} : { color: wire.color as SpatialNode['color'] }),
    ...(wire.resource === undefined ? {} : { resource: wire.resource }),
    ...(wire.label === undefined ? {} : { label: wire.label }),
  } as SpatialNode
}

function wireOf(spec: CaseSpec, index: number): NodeWire {
  const resource = RESOURCES[spec.resource]
  return {
    id: `n${index}-${spec.resource}`,
    box: spec.box.map(hex),
    ...(spec.color === null ? {} : { color: spec.color }),
    ...(resource === null || resource === undefined ? {} : { resource }),
    ...(spec.frameLabel === null || spec.frameLabel === undefined
      ? {}
      : { label: spec.frameLabel }),
  }
}

/** The options a composer hands the box primitives for a case, and the measurer's call count. */
function optionsOf(record: Omit<CaseRecord, 'answer'>) {
  const base = createFakeMeasure()
  let calls = 0
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    calls += 1
    return base(text, font)
  }
  const appearance =
    record.theme === 'sketch'
      ? createThemedAppearance({ tokens: sketch!, mode: 'light', fontFamily: 'Yomogi' })
      : createSpatialTheme({ mode: record.theme })
  const [paddingPx, labelFontSizePx, minContentWidthPx] = record.geometry.map(fromHex) as [
    number,
    number,
    number,
  ]
  const options = {
    measure,
    appearance,
    geometry: { paddingPx, labelFontSizePx, minContentWidthPx },
    fitToBox: record.fitToBox,
    nodeOutlines: record.shape === null ? undefined : { [record.node.id]: record.shape },
    shapeTable: BUNDLED_SHAPE_TABLE,
    contributions: [visualRenderContribution],
    ...(record.theme === 'sketch' ? { activeTheme: { id: 'visual.sketch', tokens: sketch } } : {}),
  } as unknown as ResolvedLayoutOptions
  return { options, calls: () => calls }
}

const resolvedOf = (wire: ResolvedWire): ResolvedReference | undefined =>
  wire === null ? undefined : (wire as ResolvedReference)

/** What the box primitives answer for a case, from its inputs alone. */
function answerOf(record: Omit<CaseRecord, 'answer'>): CaseAnswer {
  const node = withAlign(nodeOf(record.node), record.align)
  const { options, calls } = optionsOf(record)
  const content: Scene = contentScene(record.content)
  const bounds = nodeContentBounds(node, options)
  const label = labelOf(node, resolvedOf(record.resolved))
  const fit = fitSceneInNode(content, node, options)
  const fitText = fit === undefined ? undefined : dump(fit.nodes)
  return {
    bounds: [bounds.x, bounds.y, bounds.w, bounds.h].map(hex),
    width: hex(contentWidth(node, options)),
    chrome: dump([chromeShape(node, options)]),
    fitted: dump([chromeWithFit(node, options, { truncated: true, overflows: true })]),
    label: label ?? null,
    above: dump(labelRuns(node, label, 'above', options)),
    inside: dump(labelRuns(node, label, 'inside', options)),
    probe: dump(labelRuns(node, record.probe, 'inside', options)),
    placed: digest(dump(placeInNode(node, content, options))),
    lifted: digest(dump(placeAboveNode(node, content))),
    fit:
      fit === undefined || fitText === undefined
        ? null
        : { ...digest(fitText), truncated: fit.truncated, overflows: fit.overflows },
    calls: calls(),
  }
}

const SEED_IDS = ['', 'a', 'node-1', 'n0-text', '日本', '😀', 'x'.repeat(300), '\u0000￿']

const TRANSLATIONS: readonly (readonly [number, number])[] = [
  [0, 0],
  [12.5, -7.25],
  [-0, 0],
  [Number.NaN, 3],
  [5, Number.POSITIVE_INFINITY],
  [1e-300, 1e300],
]

function caseRecord(spec: CaseSpec, index: number): CaseRecord {
  const input = {
    kind: 'case' as const,
    id: spec.id,
    node: wireOf(spec, index),
    theme: spec.theme,
    fitToBox: spec.fitToBox,
    align: spec.align,
    shape: spec.shape,
    geometry: spec.geometry.map(hex),
    resolved: spec.resolved,
    probe: spec.probe,
    content: spec.content,
  }
  return { ...input, answer: answerOf(input) }
}

/** Every record, in file order: the meta line, the seeds, the translations, then the cases. */
export function nodeBoxRecords(): readonly NodeBoxRecord[] {
  const scenes = contents()
  const translations: TranslateRecord[] = Object.keys(scenes).flatMap((name) =>
    TRANSLATIONS.map(([dx, dy]) => ({
      kind: 'translate' as const,
      content: name,
      dx: hex(dx),
      dy: hex(dy),
      ...digest(dump(translateScene(contentScene(name), dx, dy).nodes)),
    })),
  )
  return [
    { kind: 'meta', sketch, contents: scenes },
    { kind: 'seed', ids: SEED_IDS, seeds: SEED_IDS.map(seedFromId) },
    ...translations,
    ...caseSpecs().map(caseRecord),
  ]
}

/** A recorded record answered again from its inputs. */
export function reanswer(record: NodeBoxRecord): NodeBoxRecord {
  switch (record.kind) {
    case 'meta':
      return { kind: 'meta', sketch, contents: contents() }
    case 'seed':
      return { ...record, seeds: record.ids.map(seedFromId) }
    case 'translate':
      return {
        ...record,
        ...digest(
          dump(
            translateScene(contentScene(record.content), fromHex(record.dx), fromHex(record.dy))
              .nodes,
          ),
        ),
      }
    case 'case': {
      const { answer: _recorded, ...input } = record
      return { ...input, answer: answerOf(input) }
    }
  }
}
