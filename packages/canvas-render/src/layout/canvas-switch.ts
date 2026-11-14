import { nodeFile, type SpatialCanvas, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { CanvasLayoutRequest, CoreDegradation } from '../canvas-core.js'
import { highlightCode } from '../highlight/lowlight.js'
import { measureSpecOf } from '../measure.js'
import { type ReferenceExtra, wireOfSeams } from '../references/wire.js'
import { bundledThemeModeOf } from '../theme/spatial-theme.js'
import type { EdgeAnchorPair } from './edges/edge-sides.js'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from './layout-options.js'

// The whole layout's switch (ADR-0054 step 7): which requests the Rust core
// can be handed, and who answers one under `ts`, `differential` and `rust`.

/** Every file node of a canvas, the ones of the canvases it nests in a file node included. */
function fileNodes(canvases: readonly SpatialCanvas[]): SpatialNode[] {
  return canvases.flatMap((canvas) => canvas.nodes.filter((node) => nodeFile(node) !== undefined))
}

/**
 * The caller's expansion policy as one answer over every node it could be
 * asked about, or undefined when it answers some open and some closed.
 */
function expansion(
  policy: ((node: SpatialNode) => boolean) | undefined,
  canvases: readonly SpatialCanvas[],
): boolean | undefined {
  if (policy === undefined) return false
  const answers = new Set(fileNodes(canvases).map((node) => policy(node) === true))
  if (answers.size > 1) return undefined
  return answers.has(true)
}

const hasData = (extra: ReferenceExtra): boolean =>
  extra.canvas === undefined && extra.markdown === undefined

/** The options no request can carry, since each is a function or a choice the core does not make. */
function carriesOnlyData(options: SpatialLayoutOptions): boolean {
  const passed = [
    options.parseBody,
    options.renderContributions,
    options.renderMath,
    options.renderDiagram,
    options.resolveEmbed,
    options.resolveTitle,
    options.resolveAlias,
    options.resolveReference,
    options.nestedLayoutBudget,
  ]
  const highlighter = options.highlightCode === undefined || options.highlightCode === highlightCode
  const style = options.style === undefined || options.style === 'clean'
  const threads = options.commentLayer === false || (options.threads ?? []).length === 0
  const proposals = (options.proposals ?? []).length === 0
  return passed.every((seam) => seam === undefined) && highlighter && style && threads && proposals
}

/**
 * `options` as a request the core answers exactly as the TypeScript would,
 * or undefined when they hold something it cannot be handed: a seam that is
 * a function, a measurer or an appearance nobody named, a theme to draw, an
 * annotation or proposal layer, a reference bundle not rebuilt from a wire
 * or one whose extras carry content, and an expansion policy that answers
 * some nodes open and others closed.
 */
export function canvasLayoutRequest(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): CanvasLayoutRequest | undefined {
  const measure = measureSpecOf(options.measure)
  const mode = bundledThemeModeOf(options.appearance)
  const wire = options.references === undefined ? undefined : wireOfSeams(options.references)
  if (measure === undefined || mode === undefined || !carriesOnlyData(options)) return undefined
  if (options.references !== undefined && wire === undefined) return undefined
  if (wire !== undefined && !wire.extras.every(([, extra]) => hasData(extra))) return undefined
  const nested = (wire?.entries ?? []).flatMap(([, entry]) => entry?.canvas ?? [])
  const expand = expansion(options.expandFileNode, [canvas, ...nested])
  if (expand === undefined) return undefined
  return {
    canvas,
    measure,
    mode,
    expand,
    ...dataOptions(options),
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

/** What a reader compares: the scene, the anchors by edge id, the events without a thrown value. */
function comparable(laid: LaidOutCanvas, events: readonly CoreDegradation[]) {
  return { scene: laid.scene, anchors: Object.fromEntries(laid.anchors), events }
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
 * core declines, and a core that throws (reported), the TypeScript answers.
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
  if (request === undefined) return ts(options)
  let answer: ReturnType<typeof core.layout.layoutSpatialCanvas>
  try {
    answer = core.layout.layoutSpatialCanvas(request)
  } catch (err) {
    core.onMismatch?.({ fn: 'layoutSpatialCanvas', kind: 'refused', err, repro: request })
    return ts(options)
  }
  if ('declined' in answer) return ts(options)
  const rust = { scene: answer.scene, anchors: answer.anchors }
  if (impl === 'rust') {
    for (const event of answer.degradations) options.onDegrade?.(hostEvent(event))
    return rust
  }
  const events: CoreDegradation[] = []
  const laid = ts({
    ...options,
    onDegrade: (event) => {
      events.push(coreEvent(event))
      options.onDegrade?.(event)
    },
  })
  const tsValue = comparable(laid, events)
  const rustValue = comparable(rust, answer.degradations)
  const at = firstDifference(tsValue, rustValue)
  if (at !== undefined) {
    core.onMismatch?.({
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
