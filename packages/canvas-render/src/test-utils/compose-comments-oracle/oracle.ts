import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { CommentThread } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
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
import { type Board, boards, type CaseSpec, caseSpecs, THROWING_BODY } from './corpus.js'

/**
 * The recorded answers of the comment layer (`composeRegionOutlines` and
 * `composeComments` in `layout/comments.ts`) as the walk draws it over a
 * whole canvas: the scene, where the walk's own share of it ends (found by
 * laying the canvas out again with the comment layer off), and every question
 * the layer asked the measurer past the walk's, bodies and labels included.
 *
 * A comment's markdown is parsed by the host, which is a seam in the Rust port,
 * so the meta line carries each message's tree as `parseBody` answers it, with
 * no reference resolution (a bubble resolves none); `null` is a body the
 * parser throws on.
 */

interface MetaRecord {
  readonly kind: 'meta'
  readonly themes: typeof THEMES
  readonly library: Record<string, never>
  readonly bodies: ReturnType<typeof bodiesOf>
  /** Each message's markdown, as the comment layer's parser answers it. */
  readonly markdown: Readonly<Record<string, MdastRoot | null>>
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
    /** What the comment layer asked the measurer: text, family and size. */
    readonly layerCalls: readonly (readonly [string, string, string])[]
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
    parseBody,
    threads,
    ...(spec.style === undefined ? {} : { style: spec.style }),
    ...(spec.showResolved === undefined ? {} : { showResolved: spec.showResolved }),
    ...(spec.obstacles === undefined
      ? {}
      : { commentObstacles: spec.obstacles.map(([x, y, w, h]) => ({ x, y, w, h })) }),
  }
}

/** codec's parser, throwing on the one body the corpus marks. */
function parseBody(text: string): MdastRoot {
  if (text === THROWING_BODY) throw new Error('compose-comments-oracle: a body that does not parse')
  return parseMarkdownBody(text)
}

const fresh = (): Run => ({ asked: [], events: [] })

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
  const layerCalls = run.asked
    .slice(walk.asked.length)
    .map(({ text, font }) => [text, font.family, hex(font.sizePx)] as const)
  return {
    scene: dump(scene.nodes),
    from,
    layerCalls,
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
    markdown: Object.fromEntries(
      boards().flatMap((board) =>
        board.threads.flatMap((thread) =>
          thread.messages.map(({ body }) => [
            body,
            body === THROWING_BODY ? null : viaJson(parseMarkdownBody(body)),
          ]),
        ),
      ),
    ),
    references: {},
    embeds: {},
  }
  return [meta, ...caseSpecs().map(caseRecord)]
}
