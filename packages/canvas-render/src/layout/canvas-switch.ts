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
  CanvasLayoutCore,
  CanvasLayoutRequest,
  CanvasLayoutSeam,
  CanvasLayoutSkip,
  CoreChange,
  CoreDegradation,
  CoreProposal,
  CoreThread,
} from '../canvas-core.js'
import { highlightCode } from '../highlight/lowlight.js'
import { measureSpecOf } from '../measure.js'
import { type ReferenceExtra, wireOfSeams } from '../references/wire.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { bundledThemeModeOf } from '../theme/spatial-theme.js'
import { resolveThemeTable } from './canvas-theme.js'
import type { EdgeAnchorPair } from './edges/edge-sides.js'
import { usesFragmentTable } from './fragment-table.js'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from './layout-options.js'
import type { FragmentAsk } from './nodes/fragment-ask.js'

// The whole layout's switch (ADR-0054 step 7): which requests the Rust core
// can be handed, and who answers one under `ts`, `differential` and `rust`.

/** Every file node of a canvas, the ones of the canvases it nests in a file node included. */
function fileNodes(canvases: readonly SpatialCanvas[]): SpatialNode[] {
  return canvases.flatMap((canvas) => canvas.nodes.filter((node) => nodeFile(node) !== undefined))
}

/**
 * The caller's expansion policy settled over every node it could be asked
 * about: one answer when it answers them all alike, else the ids it opens; or
 * undefined when it answers one id open on one node and closed on another,
 * which a set of ids cannot carry.
 */
function expansion(
  policy: ((node: SpatialNode) => boolean) | undefined,
  canvases: readonly SpatialCanvas[],
): boolean | string[] | undefined {
  if (policy === undefined) return false
  const answers = new Map<string, boolean>()
  for (const node of fileNodes(canvases)) {
    const open = policy(node) === true
    if (answers.get(node.id) === !open) return undefined
    answers.set(node.id, open)
  }
  const kinds = new Set(answers.values())
  if (kinds.size < 2) return kinds.has(true)
  return [...answers].flatMap(([id, open]) => (open ? [id] : []))
}

const hasData = (extra: ReferenceExtra): boolean =>
  extra.canvas === undefined && extra.markdown === undefined

const SEAMS = [
  'parseBody',
  'renderContributions',
  'renderMath',
  'renderDiagram',
  'resolveEmbed',
  'resolveTitle',
  'resolveAlias',
  'resolveReference',
  'nestedLayoutBudget',
] as const satisfies readonly CanvasLayoutSeam[]

/** The first option no request can carry, since it is a function or a choice the core does not make. */
function optionSkip(options: SpatialLayoutOptions): CanvasLayoutSkip | undefined {
  const seam = SEAMS.find((name) => options[name] !== undefined)
  if (seam !== undefined) return `seam:${seam}`
  if (options.highlightCode !== undefined && options.highlightCode !== highlightCode) {
    return 'highlighter'
  }
  return undefined
}

/**
 * The style a request carries, absent when it draws clean; and under any
 * other, the families the bundled themes name that this surface holds. The
 * layout asks `fontAvailable` about a theme's family and nothing else, so
 * this list answers every question it would.
 */
function styleOptions(options: SpatialLayoutOptions): Partial<CanvasLayoutRequest> {
  const { style } = options
  if (style === undefined || style === 'clean') return {}
  const available = options.fontAvailable ?? ((family) => family === SPATIAL_THEME_FONT_FAMILY)
  const named = Object.values(resolveThemeTable([visualRenderContribution])).flatMap(
    (tokens) => tokens.fontFamily ?? [],
  )
  const fontFamilies = [...new Set(named)].filter((family) => available(family))
  return { style, ...(fontFamilies.length === 0 ? {} : { fontFamilies }) }
}

/** A request the core can be handed, or why the options cannot be. */
export type CanvasLayoutAsk = CanvasLayoutRequest | { readonly skip: CanvasLayoutSkip }

/**
 * `options` as a request the core answers exactly as the TypeScript would,
 * or the first reason they cannot be one (`CanvasLayoutSkip`): a measurer or
 * an appearance nobody named, a seam that is a function, a reference
 * bundle not rebuilt from a wire
 * or one whose extras carry content, and an expansion policy that answers
 * one node id open in one canvas and closed in another.
 */
export function canvasLayoutRequest(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): CanvasLayoutAsk {
  const measure = measureSpecOf(options.measure)
  if (measure === undefined) return { skip: 'measure' }
  const mode = bundledThemeModeOf(options.appearance)
  if (mode === undefined) return { skip: 'appearance' }
  const skip = optionSkip(options)
  if (skip !== undefined) return { skip }
  const wire = options.references === undefined ? undefined : wireOfSeams(options.references)
  if (options.references !== undefined && wire === undefined) return { skip: 'references' }
  if (wire !== undefined && !wire.extras.every(([, extra]) => hasData(extra))) {
    return { skip: 'reference-content' }
  }
  const nested = (wire?.entries ?? []).flatMap(([, entry]) => entry?.canvas ?? [])
  const expand = expansion(options.expandFileNode, [canvas, ...nested])
  if (expand === undefined) return { skip: 'expand-collision' }
  return {
    canvas,
    measure,
    mode,
    expand,
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

/**
 * The path to the first value two answers part at, or undefined when they
 * agree. A key holding `undefined` reads as absent, as it would to anyone
 * reading the scene, and every number is compared with `Object.is`.
 */
export function firstDifference(a: unknown, b: unknown, at = ''): string | undefined {
  if (Object.is(a, b)) return undefined
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return at
  if (Array.isArray(a) !== Array.isArray(b)) return at
  const keys = (o: object) =>
    Object.entries(o).flatMap(([key, value]) => (value === undefined ? [] : [key]))
  const ka = keys(a)
  const kb = keys(b)
  for (const key of new Set([...ka, ...kb])) {
    const found = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${at}/${key}`,
    )
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * What a reader compares: the scene, the anchors by edge id, the events
 * without a thrown value, and the fragment sources asked for.
 */
function comparable(
  laid: LaidOutCanvas,
  events: readonly CoreDegradation[],
  asks: readonly FragmentAsk[] | undefined,
) {
  return {
    scene: laid.scene,
    anchors: Object.fromEntries(laid.anchors),
    events,
    fragmentsAsked: asks ?? [],
  }
}

function coreEvent(event: SpatialLayoutDegradation): CoreDegradation {
  if (event.kind !== 'body-parse-failed') return event
  return { kind: event.kind, nodeId: event.nodeId }
}

function hostEvent(event: CoreDegradation): SpatialLayoutDegradation {
  return event.kind === 'body-parse-failed' ? { ...event, err: undefined } : event
}

const valueAt = (root: unknown, path: string): unknown =>
  path
    .split('/')
    .slice(1)
    .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], root)

/**
 * A canvas laid out as `options.core` says: by the TypeScript when no core or
 * no whole-layout core is given, its switch reads `ts`, or the request is one
 * the core cannot be handed; under `rust` by the core, its degradations
 * reported as the TypeScript's would be; under `differential` by the
 * TypeScript with the core run beside it and any difference reported. What the
 * request gate skips and what the core declines (each reported by its class,
 * so a run can count them), and a core that throws (reported), the
 * TypeScript answers.
 */
export function layoutThroughCore(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
  ts: (options: SpatialLayoutOptions) => LaidOutCanvas,
): LaidOutCanvas {
  const core = options.core
  const impl = core?.impl.layoutSpatialCanvas ?? 'ts'
  if (core?.layout === undefined || impl === 'ts') return ts(options)
  const request = canvasLayoutRequest(stored, options)
  if ('skip' in request) {
    core.onMismatch?.({ fn: 'layoutSpatialCanvas', kind: 'skipped', reason: request.skip })
    return ts(options)
  }
  let answer: ReturnType<typeof core.layout.layoutSpatialCanvas>
  try {
    answer = core.layout.layoutSpatialCanvas(
      request,
      highlightCode,
      options.measure,
      options.contentCache,
    )
  } catch (err) {
    core.onMismatch?.({ fn: 'layoutSpatialCanvas', kind: 'refused', err, repro: request })
    return ts(options)
  }
  if ('declined' in answer) {
    core.onMismatch?.({ fn: 'layoutSpatialCanvas', kind: 'declined', reason: answer.declined })
    return ts(options)
  }
  if (impl === 'rust') {
    for (const event of answer.degradations) options.onDegrade?.(hostEvent(event))
    if (answer.fragmentsAsked?.length) options.onFragmentsAsked?.(answer.fragmentsAsked)
    return { scene: answer.scene, anchors: answer.anchors }
  }
  return compared(answer, request, options, ts)
}

/** `differential`'s answer: the TypeScript's, with the core's compared beside it and a difference reported. */
function compared(
  answer: Exclude<ReturnType<CanvasLayoutCore['layoutSpatialCanvas']>, { declined: string }>,
  request: CanvasLayoutRequest,
  options: SpatialLayoutOptions,
  ts: (options: SpatialLayoutOptions) => LaidOutCanvas,
): LaidOutCanvas {
  const events: CoreDegradation[] = []
  let asks: readonly FragmentAsk[] | undefined
  const laid = ts({
    ...options,
    onDegrade: (event) => {
      events.push(coreEvent(event))
      options.onDegrade?.(event)
    },
    ...(usesFragmentTable(options) && {
      onFragmentsAsked: (asked: readonly FragmentAsk[]) => {
        asks = asked
        options.onFragmentsAsked?.(asked)
      },
    }),
  })
  const tsValue = comparable(laid, events, asks)
  const rustValue = comparable(answer, answer.degradations, answer.fragmentsAsked)
  const at = firstDifference(tsValue, rustValue)
  if (at !== undefined) {
    options.core?.onMismatch?.({
      fn: 'layoutSpatialCanvas',
      kind: 'differs',
      at,
      ts: valueAt(tsValue, at),
      rust: valueAt(rustValue, at),
      repro: request,
    })
  }
  return laid
}
