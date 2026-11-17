import {
  type CommentThread,
  nodeFile,
  type Proposal,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type {
  CanvasLayoutRequest,
  CoreChange,
  CoreDegradation,
  CoreProposal,
  CoreThread,
} from '../canvas-core.js'
import { highlightCode } from '../highlight/lowlight.js'
import { measureSpecOf } from '../measure.js'
import { type ReferenceExtra, wireOfSeams } from '../references/wire.js'
import { type LayoutRefusal, refusalScene } from '../refusal.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { bundledThemeModeOf, type SpatialThemeMode } from '../theme/spatial-theme.js'
import { resolveThemeTable } from './canvas-theme.js'
import type { EdgeAnchorPair } from './edges/edge-sides.js'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from './layout-options.js'

// The whole layout through the Rust core (ADR-0054 step 7): the request a
// layout's options make, and what a surface is answered with. The core is the
// only layout there is (S18h deleted the TypeScript composer).

/** Every file node of a canvas, the ones of the canvases it nests in a file node included. */
function fileNodes(canvases: readonly SpatialCanvas[]): SpatialNode[] {
  return canvases.flatMap((canvas) => canvas.nodes.filter((node) => nodeFile(node) !== undefined))
}

/**
 * The caller's expansion policy settled over every node it could be asked
 * about: one answer when it answers them all alike, else the ids it opens.
 * A set of ids cannot carry one id open on one node and closed on another, so
 * the first canvas to name an id settles it: `canvases` lists the board before
 * those it nests, so the outer answer wins (owner decision q82, D8b).
 */
function expansion(
  policy: ((node: SpatialNode) => boolean) | undefined,
  canvases: readonly SpatialCanvas[],
): boolean | string[] {
  if (policy === undefined) return false
  const answers = new Map<string, boolean>()
  for (const node of fileNodes(canvases)) {
    if (!answers.has(node.id)) answers.set(node.id, policy(node) === true)
  }
  const kinds = new Set(answers.values())
  if (kinds.size < 2) return kinds.has(true)
  return [...answers].flatMap(([id, open]) => (open ? [id] : []))
}

/**
 * Whether a layout reads a fragment table: one handed a table, or a listener
 * for what the table lacks (a listener with no table asks for every source).
 */
const usesFragmentTable = (
  options: Pick<SpatialLayoutOptions, 'fragments' | 'onFragmentsAsked'>,
): boolean => options.fragments !== undefined || options.onFragmentsAsked !== undefined

export const hasData = (extra: ReferenceExtra): boolean =>
  extra.canvas === undefined && extra.markdown === undefined

/**
 * A layout's options that no request can carry: a measurer or an appearance
 * nobody named, or a reference bundle not rebuilt from a wire. A defect in
 * the root that built them, since every root names its measurer and builds
 * its references from a wire.
 */
export class CoreUnaskable extends Error {
  constructor(readonly reason: string) {
    super(`the layout's options cannot be handed to the Rust core: ${reason}`)
    this.name = 'CoreUnaskable'
  }
}

/**
 * The style a request carries, absent when it draws clean; and under any
 * other, the families the bundled themes name that this surface holds. The
 * layout asks `fontAvailable` about a theme's family and nothing else, so
 * this list answers every question it would.
 */
export function styleOptions(
  options: Pick<SpatialLayoutOptions, 'style' | 'fontAvailable'>,
): Pick<CanvasLayoutRequest, 'style' | 'fontFamilies'> {
  const { style } = options
  if (style === undefined || style === 'clean') return {}
  const available = options.fontAvailable ?? ((family) => family === SPATIAL_THEME_FONT_FAMILY)
  const named = Object.values(resolveThemeTable([visualRenderContribution])).flatMap(
    (tokens) => tokens.fontFamily ?? [],
  )
  const fontFamilies = [...new Set(named)].filter((family) => available(family))
  return { style, ...(fontFamilies.length === 0 ? {} : { fontFamilies }) }
}

/**
 * `options` as the request the core answers. Throws `CoreUnaskable` for what
 * no request carries: an appearance nobody named, and a
 * reference bundle not rebuilt from a wire or one whose extras carry content.
 */
export function canvasLayoutRequest(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): CanvasLayoutRequest {
  const measure = measureSpecOf(options.measure)
  const mode = bundledThemeModeOf(options.appearance)
  if (mode === undefined) throw new CoreUnaskable('appearance')
  const wire = options.references === undefined ? undefined : wireOfSeams(options.references)
  if (options.references !== undefined && wire === undefined) {
    throw new CoreUnaskable('references')
  }
  if (wire !== undefined && !wire.extras.every(([, extra]) => hasData(extra))) {
    throw new CoreUnaskable('reference-content')
  }
  const nested = (wire?.entries ?? []).flatMap(([, entry]) => entry?.canvas ?? [])
  return {
    canvas,
    measure,
    mode,
    expand: expansion(options.expandFileNode, [canvas, ...nested]),
    ...styleOptions(options),
    ...dataOptions(options),
    ...commentOptions(options),
    ...(usesFragmentTable(options) ? { fragments: options.fragments ?? [] } : {}),
    ...(options.proposals === undefined ? {} : { proposals: options.proposals.map(coreProposal) }),
    ...(wire === undefined ? {} : { references: wire as CanvasLayoutRequest['references'] }),
  }
}

/** The options that are data already, each present only when the caller set it. */
function dataOptions(options: SpatialLayoutOptions): Partial<CanvasLayoutRequest> {
  const { geometry, lockedNodeIds, suppressedBodyNodeIds, edgeSideOverrides } = options
  const { tagLibrary, embedPath } = options
  return {
    ...(geometry === undefined ? {} : { geometry }),
    ...(lockedNodeIds === undefined ? {} : { lockedNodeIds }),
    ...(suppressedBodyNodeIds === undefined ? {} : { suppressedBodyNodeIds }),
    ...(edgeSideOverrides === undefined ? {} : { sideOverrides: [...edgeSideOverrides] }),
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
    ...(embedPath === undefined ? {} : { embedPath }),
  }
}

const coreThread = ({ id, anchor, status, messages }: CommentThread): CoreThread => ({
  id,
  anchor,
  status,
  messages: messages.map((message) => ({ id: message.id, body: message.body })),
})

/** The annotation layer's options, each present only when the caller set it. */
function commentOptions(options: SpatialLayoutOptions): Partial<CanvasLayoutRequest> {
  const { threads, commentLayer, showResolved, commentObstacles } = options
  return {
    ...(threads === undefined ? {} : { threads: threads.map(coreThread) }),
    ...(commentLayer === undefined ? {} : { commentLayer }),
    ...(showResolved === undefined ? {} : { showResolved }),
    ...(commentObstacles === undefined ? {} : { commentObstacles }),
  }
}

const coreChange = (change: Proposal['changes'][number]): CoreChange =>
  change.op === 'body.replace' ? { id: change.id, status: change.status, op: change.op } : change

const coreProposal = ({ id, changes }: Proposal): CoreProposal => ({
  id,
  changes: changes.map(coreChange),
})

/** A laid-out canvas and the anchors its routing settled. */
export interface LaidOutCanvas {
  readonly scene: Scene
  readonly anchors: ReadonlyMap<string, EdgeAnchorPair>
}

/** A core's degradation as the host reports it: a parse failure carries no thrown value across. */
export function hostEvent(event: CoreDegradation): SpatialLayoutDegradation {
  return event.kind === 'body-parse-failed' ? { ...event, err: undefined } : event
}

/**
 * A canvas laid out by `options.core`. The core's degradations reach `onDegrade` and the
 * fragment sources it asked for `onFragmentsAsked`; what it refused (owner
 * decision q81, D7) is drawn as the refusal (`refusalScene`) and told to
 * `onRefused`. A core that throws throws to the caller: there is
 * nothing to answer in its place.
 */
export function layoutThroughCore(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): LaidOutCanvas {
  const core = options.core
  const request = canvasLayoutRequest(stored, options)
  const answer = core.layout.layoutSpatialCanvas(
    request,
    highlightCode,
    options.measure,
    options.contentCache,
  )
  if ('refused' in answer) return drawnRefusal(answer.refused, stored, request.mode, options)
  for (const event of answer.degradations) options.onDegrade?.(hostEvent(event))
  if (answer.fragmentsAsked?.length) options.onFragmentsAsked?.(answer.fragmentsAsked)
  return { scene: answer.scene, anchors: answer.anchors }
}

/** A refusal told to `onRefused`, and drawn where the board's boxes are. */
function drawnRefusal(
  refused: LayoutRefusal,
  stored: SpatialCanvas,
  mode: SpatialThemeMode,
  options: SpatialLayoutOptions,
): LaidOutCanvas {
  options.onRefused?.(refused)
  const at = topLeftOf(stored)
  const scene = refusalScene(refused, {
    measure: options.measure,
    mode,
    ...(at === undefined ? {} : { at }),
  })
  return { scene, anchors: new Map() }
}

/**
 * Where a board's boxes begin, its least x and y; none for a board with no
 * box placed at a finite point. A fold rather than a spread: a refused board
 * is a large one, and spreading its nodes as arguments is bounded by the
 * engine's argument limit.
 */
function topLeftOf(canvas: SpatialCanvas): { x: number; y: number } | undefined {
  let at: { x: number; y: number } | undefined
  for (const { x, y } of canvas.nodes) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    at = at === undefined ? { x, y } : { x: Math.min(at.x, x), y: Math.min(at.y, y) }
  }
  return at
}
