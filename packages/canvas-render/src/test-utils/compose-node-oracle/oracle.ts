import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import { nodeKind, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { VISUAL_THEMES } from '@kamiazya/whiteboard-plugin-visual'
import type { RenderContribution, SceneNode } from '@kamiazya/whiteboard-scene'
import { composeFileNode } from '../../layout/compose-file-node.js'
import { composeNode } from '../../layout/compose-node.js'
import type {
  ResolvedLayoutOptions,
  SpatialContentCache,
  SpatialLayoutDegradation,
} from '../../layout/layout-options.js'
import { createNestedLayoutBudget } from '../../layout/nodes/embed-budget.js'
import type { FittedBlocks } from '../../layout/nodes/mdast-blocks.js'
import { BUNDLED_SHAPE_TABLE } from '../../layout/nodes/node-outline.js'
import type { FontDescriptor, TextMetrics } from '../../measure.js'
import type { ResolvedReference } from '../../references/resolved.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createThemedAppearance } from '../../theme/theme-asset.js'
import { createFakeMeasure } from '../fake-measure.js'
import { dumpScene, f64Hex } from '../render-oracle/scene-dump.js'
import { type CaseSpec, caseSpecs, DOC_ID, REFERENCES, RESOURCES, THROWING_BODY } from './corpus.js'

/**
 * The recorded answers of `composeNode` (`layout/compose-node.ts`): the text,
 * frame and link nodes, the dispatch between them, and the lock badge.
 *
 * A `case` record holds a node, the options a composer hands it, and what it
 * answers: the scene, the degradations reported, the content-cache keys asked
 * and kept, the scene composed again over the same cache, and the scene composed
 * over a cache seeded under the first key asked. What the composer asks a host
 * the Rust port takes as a seam — a body parsed and its references resolved, a
 * reference resolved, an embed target, a file node's canvas embed — is in the
 * meta line and the case, as data. Every double is the hex of its IEEE bits
 * (a NaN the canonical one), and `calls` counts what the measurer was asked.
 */

const sketch = VISUAL_THEMES.sketch
if (sketch === undefined)
  throw new Error('compose-node-oracle: the bundled sketch theme is missing')

/** `f64Hex`, with every NaN written as the positive quiet NaN `f64::NAN` is. */
const hex = (value: number): string => (Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value))

const dump = (nodes: readonly SceneNode[]): string => dumpScene({ nodes: [...nodes] }, hex)

const digest = (text: string): { n: number; h: number } => {
  let state = 0x811c_9dc5
  for (let i = 0; i < text.length; i += 1) {
    state = Math.imul(state ^ text.charCodeAt(i), 16_777_619) >>> 0
  }
  return { n: text.length, h: state }
}

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const fromHex = (text: string): number => {
  const view = new DataView(new ArrayBuffer(8))
  view.setUint32(0, Number.parseInt(text.slice(0, 8), 16))
  view.setUint32(4, Number.parseInt(text.slice(8), 16))
  return view.getFloat64(0)
}

/** The body the recording's parser reads, its references resolved; `null` is a parser that throws. */
const resolveAlias = (alias: string): string | null => (alias === 'doc' ? DOC_ID : null)
const parseBody = (text: string): MdastRoot => {
  if (text === THROWING_BODY) throw new Error('compose-node-oracle: a body that does not parse')
  return parseMarkdownBody(text)
}
const bodyOf = (text: string): MdastRoot | null =>
  text === THROWING_BODY ? null : viaJson(resolveReferences(parseBody(text), resolveAlias))

const EMBEDDED_BODY = 'Embedded body'
const resolveEmbed = (id: string) =>
  id === DOC_ID ? { title: 'Doc', root: parseMarkdownBody(EMBEDDED_BODY) } : undefined

const resolveReference = (ref: string): ResolvedReference | undefined => {
  const wire = REFERENCES[ref]
  if (wire === null) throw new Error('compose-node-oracle: a resolver that throws')
  return wire as ResolvedReference | undefined
}

/** What a seeded cache answers: a body no layout of these cases produces. */
const SEEDED: FittedBlocks = {
  nodes: [
    {
      kind: 'textRun',
      bbox: { x: 1, y: 2, w: 30, h: 12 },
      baseline: 10,
      text: 'cached',
    },
  ],
  truncated: true,
  overflows: false,
}

/** What the nested layout answers for any embedded canvas: one box, scaled into the node's. */
const MINIATURE: { readonly nodes: readonly SceneNode[] } = {
  nodes: [
    { kind: 'shape', bbox: { x: -10, y: 5, w: 400, h: 120 }, radius: 6 },
    {
      kind: 'textRun',
      bbox: { x: 0, y: 10, w: 80, h: 16 },
      baseline: 12,
      text: 'inside',
      appearance: { fontSize: 14 },
    },
  ],
}

interface MetaRecord {
  readonly kind: 'meta'
  readonly sketch: unknown
  /** Each body as parsed with its references resolved; `null` is a parse that throws. */
  readonly bodies: Readonly<Record<string, MdastRoot | null>>
  /** The one embed target answered, by document id. */
  readonly embedded: Readonly<Record<string, { title: string; root: MdastRoot }>>
  readonly references: typeof REFERENCES
  readonly seeded: FittedBlocks
}

/** A node as data: its box as IEEE bits, the rest as JSON. */
interface NodeWire {
  readonly id: string
  readonly box: readonly string[]
  readonly color?: string
  readonly resource?: SpatialNode['resource']
  readonly label?: string
  readonly background?: string
  readonly backgroundStyle?: string
}

interface CaseRecord {
  readonly kind: 'case'
  readonly id: string
  readonly node: NodeWire
  readonly theme: CaseSpec['theme']
  readonly fitToBox: boolean
  readonly align: CaseSpec['align']
  readonly shape: string | null
  readonly geometry: readonly string[]
  readonly embedDepth: number
  /**
   * Which of the case's switches are on: `locked`, `suppressed` (the editor owns
   * the body), `emptyFrame`, `cache` (a content cache is handed over) and
   * `spent` (the nested-layout budget has no layout left).
   */
  readonly flags: readonly Flag[]
  /**
   * The canvas a file node embeds, scaled into its box, as data: `null` when the
   * embed draws nothing and the next representation is asked. The port asks it
   * of its host until the nested layout is ported.
   */
  readonly embed: SceneNode | null
  readonly answer: CaseAnswer
}

interface CaseAnswer {
  readonly scene: string
  readonly events: readonly { kind: string; nodeId: string; detail: string }[]
  readonly asked: readonly string[]
  readonly kept: readonly string[]
  readonly again: { n: number; h: number }
  readonly seeded: { n: number; h: number } | null
  readonly calls: number
}

export type ComposeNodeRecord = MetaRecord | CaseRecord

function nodeOf(wire: NodeWire): SpatialNode {
  const [x, y, width, height] = wire.box.map(fromHex) as [number, number, number, number]
  const { box: _box, ...rest } = wire
  return { ...rest, x, y, width, height } as SpatialNode
}

function wireOf(spec: CaseSpec, index: number): NodeWire {
  const resource = RESOURCES[spec.resource]
  return {
    id: `n${index}-${spec.resource}`,
    box: spec.box.map(hex),
    ...(spec.color === null ? {} : { color: spec.color }),
    ...(resource === null || resource === undefined ? {} : { resource }),
    ...(spec.frameLabel === undefined ? {} : { label: spec.frameLabel }),
    ...(spec.background === undefined ? {} : { background: spec.background }),
    ...(spec.backgroundStyle === undefined ? {} : { backgroundStyle: spec.backgroundStyle }),
  }
}

/** A cache that remembers what it was asked and what it kept. */
class RecordingCache implements SpatialContentCache {
  readonly asked: string[] = []
  readonly kept: string[] = []
  readonly entries = new Map<string, FittedBlocks>()
  get(key: string): FittedBlocks | undefined {
    this.asked.push(key)
    return this.entries.get(key)
  }
  set(key: string, value: FittedBlocks): void {
    this.kept.push(key)
    this.entries.set(key, value)
  }
}

type Flag = 'locked' | 'suppressed' | 'emptyFrame' | 'cache' | 'spent'
const FLAGS: readonly Flag[] = ['locked', 'suppressed', 'emptyFrame', 'cache', 'spent']

type Input = Omit<CaseRecord, 'answer'>

const appearanceOf = (theme: CaseSpec['theme']) =>
  theme === 'sketch'
    ? createThemedAppearance({ tokens: sketch!, mode: 'light', fontFamily: 'Yomogi' })
    : createSpatialTheme({ mode: theme })

/** The options a composer hands `composeNode` for a case. */
function optionsOf(
  record: Input,
  count: () => void,
  events: SpatialLayoutDegradation[],
  cache: SpatialContentCache | undefined,
): ResolvedLayoutOptions {
  const base = createFakeMeasure()
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    count()
    return base(text, font)
  }
  const appearance = appearanceOf(record.theme)
  const [paddingPx, labelFontSizePx, minContentWidthPx] = record.geometry.map(fromHex) as [
    number,
    number,
    number,
  ]
  const placement: RenderContribution = {
    namespace: 'oracle',
    readTextPlacement: () => record.align ?? undefined,
  }
  const budget = createNestedLayoutBudget()
  const on = (flag: Flag) => record.flags.includes(flag)
  if (on('spent')) budget.remaining = 0
  const id = record.node.id
  return {
    measure,
    appearance,
    geometry: { paddingPx, labelFontSizePx, minContentWidthPx },
    fitToBox: record.fitToBox,
    nodeOutlines: record.shape === null ? undefined : { [id]: record.shape },
    shapeTable: BUNDLED_SHAPE_TABLE,
    contributions: [placement],
    ...(record.theme === 'sketch' ? { activeTheme: { id: 'visual.sketch', tokens: sketch } } : {}),
    parseBody,
    resolveAlias,
    resolveEmbed,
    resolveReference,
    nestedLayoutBudget: budget,
    activeEmbedPath: new Set<string>(),
    embedDepth: record.embedDepth,
    passagesByNode: new Map(),
    suppressedBodyNodeIds: on('suppressed') ? [id] : [],
    lockedNodeIds: on('locked') ? [id] : [],
    emptyFrameIds: new Set(on('emptyFrame') ? [id] : []),
    onDegrade: (event: SpatialLayoutDegradation) => events.push(event),
    ...(cache === undefined ? {} : { contentCache: cache }),
    expandFileNode: () => true,
    layoutNestedCanvas: () => MINIATURE,
  } as unknown as ResolvedLayoutOptions
}

const detailOf = (event: SpatialLayoutDegradation): string =>
  event.kind === 'unknown-node-kind'
    ? event.type
    : event.kind === 'unsupported-background-style'
      ? event.style
      : ''

/** What `composeNode` answers for a case, from its inputs alone. */
function answerOf(record: Input): CaseAnswer {
  const node = nodeOf(record.node)
  let calls = 0
  const count = () => {
    calls += 1
  }
  const events: SpatialLayoutDegradation[] = []
  const cache = record.flags.includes('cache') ? new RecordingCache() : undefined
  const scene = dump(composeNode(node, optionsOf(record, count, events, cache)))
  const again = digest(dump(composeNode(node, optionsOf(record, count, events, cache))))
  const first = cache?.asked[0]
  let seeded: { n: number; h: number } | null = null
  if (first !== undefined) {
    const seed = new RecordingCache()
    seed.entries.set(first, SEEDED)
    seeded = digest(dump(composeNode(node, optionsOf(record, count, events, seed))))
  }
  return {
    scene,
    events: events.map((e) => ({
      kind: e.kind,
      nodeId: 'nodeId' in e ? e.nodeId : '',
      detail: detailOf(e),
    })),
    asked: cache?.asked ?? [],
    kept: cache?.kept ?? [],
    again,
    seeded,
    calls,
  }
}

/**
 * The canvas embed a file node draws, as the composer draws it: the one
 * `embedResolved` entry at the top of its scene, which no other representation
 * puts there. Recorded as JSON, so it is checked to survive the trip.
 */
function embedOf(record: Omit<Input, 'embed'>): SceneNode | null {
  if (nodeKind(nodeOf(record.node)) !== 'file') return null
  const options = optionsOf({ ...record, embed: null }, () => {}, [], undefined)
  const drawn = composeFileNode(nodeOf(record.node), options)
  const embed = drawn.find((entry) => entry.kind === 'embedResolved')
  if (embed === undefined) return null
  const wire = viaJson(embed)
  if (dump([wire]) !== dump([embed])) {
    throw new Error(`compose-node-oracle: ${record.id}'s embed does not survive JSON`)
  }
  return wire
}

function caseRecord(spec: CaseSpec, index: number): CaseRecord {
  const partial = {
    kind: 'case' as const,
    id: spec.id,
    node: wireOf(spec, index),
    theme: spec.theme,
    fitToBox: spec.fitToBox,
    align: spec.align,
    shape: spec.shape,
    geometry: spec.geometry.map(hex),
    embedDepth: spec.embedDepth,
    flags: FLAGS.filter((flag) => spec[flag]),
  }
  const input = { ...partial, embed: embedOf(partial) }
  return { ...input, answer: answerOf(input) }
}

function metaRecord(): MetaRecord {
  const bodies = Object.values(RESOURCES).flatMap((resource) =>
    resource?.content === undefined ? [] : [resource.content],
  )
  return {
    kind: 'meta',
    sketch,
    bodies: Object.fromEntries(bodies.map((body) => [body, bodyOf(body)])),
    embedded: {
      [DOC_ID]: { title: 'Doc', root: viaJson(parseMarkdownBody(EMBEDDED_BODY)) },
    },
    references: REFERENCES,
    seeded: viaJson(SEEDED),
  }
}

/** Every record, in file order: the meta line, then the cases. */
export function composeNodeRecords(): readonly ComposeNodeRecord[] {
  return [metaRecord(), ...caseSpecs().map(caseRecord)]
}

/** A recorded record answered again from its inputs. */
export function reanswer(record: ComposeNodeRecord): ComposeNodeRecord {
  if (record.kind === 'meta') return metaRecord()
  const { answer: _recorded, ...input } = record
  return { ...input, answer: answerOf(input) }
}
