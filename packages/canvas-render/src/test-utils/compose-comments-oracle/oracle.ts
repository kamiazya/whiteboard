import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { CommentThread } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
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
import { proposalLabels, THROWING_LABEL } from '../proposal-oracle/layer-corpus.js'
import { type ProposalWire, proposalWire } from '../proposal-oracle/wire.js'
import { type Board, boards, type CaseSpec, caseSpecs, THROWING_BODY } from './corpus.js'

/**
 * The recorded answers of the comment layer (`composeRegionOutlines` and
 * `composeComments` in `layout/comments.ts`, and the passage highlights
 * `composePassageHighlights` draws behind a text node's body) as the walk
 * draws it over a whole canvas: the scene, where the walk's own share of it
 * ends (found by laying the canvas out again with the comment layer off, which
 * draws the same walk less its highlights), and every question the layout
 * asked the measurer, bodies, highlights and labels included.
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
  | {
      readonly kind: 'text'
      readonly nodeId?: string
      readonly quote: { readonly prefix?: string; readonly exact: string; readonly suffix?: string }
      readonly start: number
      readonly end: number
    }
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
  readonly proposals?: readonly ProposalWire[]
  readonly obstacles?: readonly (readonly string[])[]
  readonly answer: {
    readonly scene: string
    /** Every question the layout asked the measurer: text, family and size. */
    readonly calls: readonly (readonly [string, string, string])[]
    readonly events: readonly Event[]
  }
}

export type ComposeCommentsRecord = MetaRecord | CaseRecord

const anchorWire = (anchor: CommentThread['anchor']): AnchorWire => {
  if (anchor.kind === 'document') return { kind: 'document' }
  if (anchor.kind === 'text') {
    const { kind, nodeId, quote, start, end } = anchor
    return { kind, ...(nodeId === undefined ? {} : { nodeId }), quote, start, end }
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
  return spec.appearance === 'bare'
    ? { ...theme, resolveComment: undefined, resolveProposal: undefined }
    : theme
}

function optionsOf(spec: CaseSpec, board: Board, run: Run): SpatialLayoutOptions {
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
    threads: board.threads,
    ...(board.proposals === undefined ? {} : { proposals: board.proposals }),
    ...(spec.style === undefined ? {} : { style: spec.style }),
    ...(spec.showResolved === undefined ? {} : { showResolved: spec.showResolved }),
    ...(spec.obstacles === undefined
      ? {}
      : { commentObstacles: spec.obstacles.map(([x, y, w, h]) => ({ x, y, w, h })) }),
  }
}

const throws = (text: string): boolean => text === THROWING_BODY || text === THROWING_LABEL

/** codec's parser, throwing on the one body and the one label the corpus marks. */
function parseBody(text: string): MdastRoot {
  if (throws(text)) throw new Error('compose-comments-oracle: a body that does not parse')
  return parseMarkdownBody(text)
}

const fresh = (): Run => ({ asked: [], events: [] })

/** A passage highlight: comment chrome the walk draws inside a text node. */
const isPassage = (node: SceneNode): boolean =>
  node.kind === 'shape' && node.commentChrome === true && /\/passage-\d+$/.test(node.id ?? '')

function answerOf(spec: CaseSpec, board: Board): CaseRecord['answer'] {
  const run = fresh()
  const { scene } = layoutSpatialCanvasWithAnchors(board.canvas, optionsOf(spec, board, run))
  const bare = layoutSpatialCanvasWithAnchors(board.canvas, {
    ...optionsOf(spec, board, fresh()),
    commentLayer: false,
    proposals: [],
  }).scene.nodes
  const highlights = scene.nodes.filter(isPassage).length
  const from = bare.length + highlights
  const walk = scene.nodes.slice(0, from).filter((node) => !isPassage(node))
  if (dump(walk) !== dump(bare) || scene.legend !== undefined) {
    throw new Error(`compose-comments-oracle: ${board.name}'s comments moved what the walk drew`)
  }
  return {
    scene: dump(scene.nodes),
    calls: run.asked.map(({ text, font }) => [text, font.family, hex(font.sizePx)] as const),
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
    ...(board.proposals === undefined ? {} : { proposals: board.proposals.map(proposalWire) }),
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
      [
        ...boards().flatMap((board) =>
          board.threads.flatMap((thread) => thread.messages.map(({ body }) => body)),
        ),
        ...proposalLabels(),
      ].map((text) => [text, throws(text) ? null : viaJson(parseMarkdownBody(text))]),
    ),
    references: {},
    embeds: {},
  }
  return [meta, ...caseSpecs().map((spec, index) => caseRecord(spec, index))]
}
