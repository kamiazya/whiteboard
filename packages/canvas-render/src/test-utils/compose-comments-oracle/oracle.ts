import type { CommentThread } from '@kamiazya/whiteboard-model'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { translateScene } from '../../layout/translate-scene.js'
import type { FontDescriptor, TextMetrics } from '../../measure.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import {
  bodiesOf,
  dump,
  type Event,
  eventOf,
  hex,
  TEST_CONTRIBUTION,
  THEMES,
  viaJson,
} from '../compose-canvas-oracle/oracle.js'
import { type CanvasWire, canvasWire } from '../compose-canvas-oracle/wire.js'
import { createFakeMeasure } from '../fake-measure.js'
import { type Board, boards, type CaseSpec, caseSpecs } from './corpus.js'

/**
 * The recorded answers of the comment layer (`composeRegionOutlines` and
 * `composeComments` in `layout/comments.ts`) as the walk draws it over a
 * whole canvas: the scene, and where the walk's own share of it ends, found by
 * laying the canvas out again with the comment layer off.
 *
 * A bubble's body is what the Rust port takes as a seam, so it is data here:
 * each comment's body as laid out at the origin, found by laying the comment
 * out alone where its bubble lands at the bubble padding's negative, then held
 * to the body the whole layout drew, translated there. The measurer's questions
 * past the walk's are recorded only at the pin count's size, since a body's own
 * questions are the seam's.
 */

const PIN_COUNT_FONT_PX = 10
const BUBBLE_PADDING_PX = 8
/** An anchor whose down-right bubble lands at minus the padding, so its body sits at the origin. */
const PROBE_ANCHOR = -(BUBBLE_PADDING_PX + 14)

interface MetaRecord {
  readonly kind: 'meta'
  readonly themes: typeof THEMES
  readonly library: Record<string, never>
  readonly bodies: ReturnType<typeof bodiesOf>
  readonly references: Record<string, never>
  readonly embeds: Record<string, never>
}

type AnchorWire =
  | {
      readonly kind: 'spatial'
      readonly nodeId?: string
      readonly edgeId?: string
      readonly nodeIds?: readonly string[]
      readonly x: string
      readonly y: string
      readonly width?: string
      readonly height?: string
    }
  | { readonly kind: 'text'; readonly nodeId?: string }
  | { readonly kind: 'document' }

interface ThreadWire {
  readonly id: string
  readonly anchor: AnchorWire
  readonly resolved: boolean
  readonly messages: readonly { readonly id: string; readonly body: string }[]
}

interface CaseRecord extends Omit<CaseSpec, 'obstacles'> {
  readonly kind: 'case'
  readonly id: string
  readonly canvas: CanvasWire
  readonly threads: readonly ThreadWire[]
  readonly obstacles?: readonly (readonly string[])[]
  readonly answer: {
    readonly scene: string
    /** How many nodes the walk drew before the comment layer. */
    readonly from: number
    /** Each drawn comment's body, laid out at the origin. */
    readonly bodies: Readonly<Record<string, readonly SceneNode[]>>
    /** What the comment layer asked the measurer at the pin count's size: text and family. */
    readonly pinCounts: readonly (readonly [string, string])[]
    /** What the walk asked the measurer. */
    readonly walkCalls: number
    readonly events: readonly Event[]
  }
}

export type ComposeCommentsRecord = MetaRecord | CaseRecord

const anchorWire = (anchor: CommentThread['anchor']): AnchorWire => {
  if (anchor.kind === 'document') return { kind: 'document' }
  if (anchor.kind === 'text') {
    return { kind: 'text', ...(anchor.nodeId === undefined ? {} : { nodeId: anchor.nodeId }) }
  }
  const { kind, x, y, width, height, ...refs } = anchor
  return {
    kind,
    ...refs,
    x: hex(x),
    y: hex(y),
    ...(width === undefined ? {} : { width: hex(width) }),
    ...(height === undefined ? {} : { height: hex(height) }),
  }
}

const threadWire = (thread: CommentThread): ThreadWire => ({
  id: thread.id,
  anchor: anchorWire(thread.anchor),
  resolved: thread.status === 'resolved',
  messages: thread.messages.map(({ id, body }) => ({ id, body })),
})

interface Asked {
  readonly text: string
  readonly font: FontDescriptor
}

interface Run {
  readonly asked: Asked[]
  readonly events: SpatialLayoutDegradation[]
}

const appearanceOf = (spec: CaseSpec) => {
  const theme = createSpatialTheme({ mode: spec.appearance === 'dark' ? 'dark' : 'light' })
  return spec.appearance === 'bare' ? { ...theme, resolveComment: undefined } : theme
}

function optionsOf(
  spec: CaseSpec,
  threads: readonly CommentThread[],
  run: Run,
): SpatialLayoutOptions {
  const base = createFakeMeasure()
  return {
    measure: (text: string, font: FontDescriptor): TextMetrics => {
      run.asked.push({ text, font })
      return base(text, font)
    },
    appearance: appearanceOf(spec),
    renderContributions: [visualRenderContribution, TEST_CONTRIBUTION],
    onDegrade: (event) => run.events.push(event),
    threads,
    ...(spec.style === undefined ? {} : { style: spec.style }),
    ...(spec.showResolved === undefined ? {} : { showResolved: spec.showResolved }),
    ...(spec.obstacles === undefined
      ? {}
      : { commentObstacles: spec.obstacles.map(([x, y, w, h]) => ({ x, y, w, h })) }),
  }
}

const fresh = (): Run => ({ asked: [], events: [] })

const idOf = (node: SceneNode): string | undefined => ('id' in node ? node.id : undefined)
const isChrome = (node: SceneNode): boolean =>
  'commentChrome' in node && node.commentChrome === true

/** The nodes after a comment's bubble, up to the next piece of chrome. */
function bodyAfterBubble(nodes: readonly SceneNode[], id: string) {
  const at = nodes.findIndex((node) => idOf(node) === `${id}/bubble`)
  if (at < 0) return undefined
  const rest = nodes.slice(at + 1)
  const end = rest.findIndex(isChrome)
  const bubble = nodes[at]
  return { bubble, body: end < 0 ? rest : rest.slice(0, end) }
}

/** A comment's body at the origin: the comment laid out alone, where its bubble lands at minus the padding. */
function probeBody(spec: CaseSpec, board: Board, thread: CommentThread): readonly SceneNode[] {
  const alone = { ...thread, anchor: { kind: 'spatial', x: PROBE_ANCHOR, y: PROBE_ANCHOR } }
  const canvas = {
    nodes: [],
    edges: [],
    ...(board.canvas.facets ? { facets: board.canvas.facets } : {}),
  }
  const options = {
    ...optionsOf(spec, [alone as CommentThread], fresh()),
    showResolved: true,
    commentObstacles: [],
  }
  const { nodes } = layoutSpatialCanvasWithAnchors(canvas, options).scene
  const found = bodyAfterBubble(nodes, thread.id)
  const box = found?.bubble !== undefined && 'bbox' in found.bubble ? found.bubble.bbox : undefined
  if (box?.x !== -BUBBLE_PADDING_PX || box.y !== -BUBBLE_PADDING_PX) {
    throw new Error(`compose-comments-oracle: ${thread.id}'s probe bubble is not at the origin`)
  }
  return found?.body ?? []
}

/** Each drawn comment's body at the origin, held to the body the whole layout drew. */
function bodiesFor(spec: CaseSpec, board: Board, drawn: readonly SceneNode[]) {
  const bodies: Record<string, readonly SceneNode[]> = {}
  for (const thread of board.threads) {
    const found = bodyAfterBubble(drawn, thread.id)
    if (found === undefined) continue
    const body = probeBody(spec, board, thread)
    const box = 'bbox' in found.bubble ? found.bubble.bbox : undefined
    const placed = translateScene(
      { nodes: [...body] },
      (box?.x ?? 0) + BUBBLE_PADDING_PX,
      (box?.y ?? 0) + BUBBLE_PADDING_PX,
    )
    if (dump(placed.nodes) !== dump(found.body)) {
      throw new Error(`compose-comments-oracle: ${board.name}'s ${thread.id} body moved`)
    }
    bodies[thread.id] = viaJson(body)
  }
  return bodies
}

function answerOf(spec: CaseSpec, board: Board): CaseRecord['answer'] {
  const run = fresh()
  const { scene } = layoutSpatialCanvasWithAnchors(
    board.canvas,
    optionsOf(spec, board.threads, run),
  )
  const walk = fresh()
  const bare = layoutSpatialCanvasWithAnchors(board.canvas, {
    ...optionsOf(spec, board.threads, walk),
    commentLayer: false,
  }).scene.nodes
  const from = bare.length
  if (dump(scene.nodes.slice(0, from)) !== dump(bare) || scene.legend !== undefined) {
    throw new Error(`compose-comments-oracle: ${board.name}'s comments moved what the walk drew`)
  }
  const pinCounts = run.asked
    .slice(walk.asked.length)
    .filter(({ font }) => font.sizePx === PIN_COUNT_FONT_PX)
    .map(({ text, font }) => [text, font.family] as const)
  return {
    scene: dump(scene.nodes),
    from,
    bodies: bodiesFor(spec, board, scene.nodes.slice(from)),
    pinCounts,
    walkCalls: walk.asked.length,
    events: run.events.map(eventOf),
  }
}

function caseRecord(spec: CaseSpec, index: number): CaseRecord {
  const board = boards().find((b) => b.name === spec.board)
  if (board === undefined) throw new Error(`compose-comments-oracle: no board ${spec.board}`)
  const { obstacles, ...rest } = spec
  return {
    kind: 'case',
    id: `${index}-${spec.board}`,
    ...rest,
    canvas: canvasWire(board.canvas, hex),
    threads: board.threads.map(threadWire),
    ...(obstacles === undefined ? {} : { obstacles: obstacles.map((box) => box.map(hex)) }),
    answer: answerOf(spec, board),
  }
}

/** Every record, in file order: the meta line, then each case. */
export function composeCommentsRecords(): readonly ComposeCommentsRecord[] {
  const meta: MetaRecord = {
    kind: 'meta',
    themes: THEMES,
    library: {},
    bodies: bodiesOf(boards().map((board) => board.canvas)),
    references: {},
    embeds: {},
  }
  return [meta, ...caseSpecs().map((spec, index) => caseRecord(spec, index))]
}
