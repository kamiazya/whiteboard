import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { CoreDegradation } from '../canvas-core.js'
import { highlightCode } from '../highlight/lowlight.js'
import { type MeasureText, measureSpecOf } from '../measure.js'
import type { QueryAnswer, QueryLayoutSkip, QueryNumbers, QueryRequest } from '../query-core.js'
import { bundledThemeModeOf } from '../theme/spatial-theme.js'
import {
  canvasLayoutRequest,
  coreEvent,
  firstDifference,
  hostEvent,
  styleOptions,
  valueAt,
} from './canvas-switch.js'
import type { LayoutCore } from './edges/layout-core.js'
import type { SpatialLayoutOptions } from './layout-options.js'

// The queries' switch (ADR-0054 step 7, S18d): which of the layout pieces a
// root calls on their own the Rust core's query entry can be handed, and who
// answers one under `ts`, `differential` and `rust`. They ride one switch key,
// `impl.layoutQuery`.

/** A query the core answered, in the core's shape. */
type Answered = Exclude<QueryAnswer, { readonly declined: string }>

/** How a query asks the core and reads its answer, and how the TypeScript answers it. */
export interface Querying<T> {
  /** The request, or why the arguments cannot be one; built only when the core is asked. */
  readonly request: () => QueryRequest | { readonly skip: QueryLayoutSkip }
  /** The TypeScript's answer. */
  readonly ts: () => T
  /** The core's answer in the TypeScript's shape, or undefined when it is not one. */
  readonly read: (answer: Answered) => T | undefined
  /** The host's measurer, for a request naming `{kind: 'host'}`. */
  readonly measure?: MeasureText
}

/**
 * A query answered as `core` says: by the TypeScript when no core or no
 * query core is given or its switch reads `ts`; under `rust` by the core;
 * under `differential` by the TypeScript with the core asked beside it and
 * the first difference reported. What the gate skips and what the core
 * declines (each counted by class), and a core that throws or answers in a
 * shape the query does not have (each reported as refused), the TypeScript
 * answers.
 */
export function queried<T>(core: LayoutCore | undefined, querying: Querying<T>): T {
  const impl = core?.impl.layoutQuery ?? 'ts'
  if (core?.query === undefined || impl === 'ts') return querying.ts()
  const request = querying.request()
  if ('skip' in request) {
    core.onMismatch?.({ fn: 'layoutQuery', kind: 'skipped', reason: request.skip })
    return querying.ts()
  }
  let rust: T | undefined
  try {
    const answer = core.query.layoutQuery(request, highlightCode, querying.measure)
    if ('declined' in answer) {
      core.onMismatch?.({ fn: 'layoutQuery', kind: 'declined', reason: answer.declined })
      return querying.ts()
    }
    rust = querying.read(answer)
    if (rust === undefined) throw new Error(`the core answered ${request.query} in another shape`)
  } catch (err) {
    core.onMismatch?.({ fn: 'layoutQuery', kind: 'refused', err, repro: request })
    return querying.ts()
  }
  if (impl === 'rust') return rust
  const ts = querying.ts()
  const at = firstDifference(ts, rust)
  if (at !== undefined) {
    core.onMismatch?.({
      fn: 'layoutQuery',
      kind: 'differs',
      at,
      ts: valueAt(ts, at),
      rust: valueAt(rust, at),
      repro: request,
    })
  }
  return ts
}

/** The numbers of a query's answer, or undefined when it answered an edge layer. */
export const numbersOf = (answer: Answered): readonly QueryNumbers[] | undefined =>
  'numbers' in answer ? answer.numbers : undefined

/** A list of exactly `n` numbers, or undefined. */
export function tupleOf(value: QueryNumbers | undefined, n: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== n) return undefined
  return value.every((v) => typeof v === 'number') ? (value as number[]) : undefined
}

/** An edge layer and the degradations the layout reported beside it. */
interface EdgeLayer {
  readonly nodes: readonly SceneNode[]
  readonly degradations: readonly CoreDegradation[]
}

/**
 * The drag frame's edge layer as `options.core` says (`layoutSpatialEdges`):
 * the request is the canvas layout's own, so whatever would send a whole
 * layout of these options to the TypeScript sends this one there too. Under
 * `rust` the core's degradations reach `onDegrade` as the TypeScript's would;
 * under `differential` the layer and the degradations are compared.
 */
export function edgesThroughCore(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
  ts: (options: SpatialLayoutOptions) => SceneNode[],
): SceneNode[] {
  const reported = (): EdgeLayer => {
    const degradations: CoreDegradation[] = []
    const nodes = ts({
      ...options,
      onDegrade: (event) => {
        degradations.push(coreEvent(event))
        options.onDegrade?.(event)
      },
    })
    return { nodes, degradations }
  }
  let rust = false
  const layer = queried<EdgeLayer>(options.core, {
    request: () => {
      const request = canvasLayoutRequest(stored, options)
      return 'skip' in request ? request : { ...request, query: 'edges' }
    },
    ts: reported,
    read: (answer) => {
      if (!('nodes' in answer)) return undefined
      rust = options.core?.impl.layoutQuery === 'rust'
      return { nodes: answer.nodes, degradations: answer.degradations }
    },
    measure: options.measure,
  })
  if (rust) for (const event of layer.degradations) options.onDegrade?.(hostEvent(event))
  return [...layer.nodes]
}

/** The options a node's natural size reads that the core's query takes as data. */
const NATURAL_OPTIONS = new Set([
  'measure',
  'appearance',
  'style',
  'fontAvailable',
  'fragments',
  'core',
])

/**
 * A node's natural content size as `options.core` says
 * (`naturalNodeContentSize`). The core's query takes the measurer, the theme
 * mode, the style with the families the surface holds, and a fragment table;
 * an option beyond those, set to anything, sends it to the TypeScript.
 */
export function naturalSizeThroughCore(
  node: SpatialNode,
  options: SpatialLayoutOptions,
  ts: () => { readonly w: number; readonly h: number },
): { readonly w: number; readonly h: number } {
  return queried(options.core, {
    request: () => {
      const measure = measureSpecOf(options.measure)
      if (measure === undefined) return { skip: 'measure' }
      const mode = bundledThemeModeOf(options.appearance)
      if (mode === undefined) return { skip: 'appearance' }
      const set = Object.entries(options).filter(([, value]) => value !== undefined)
      if (set.some(([key]) => !NATURAL_OPTIONS.has(key))) return { skip: 'options' }
      const { fragments } = options
      return {
        query: 'node-content',
        node,
        measure,
        mode,
        ...styleOptions(options),
        ...(fragments === undefined ? {} : { fragments }),
      }
    },
    ts,
    read: (answer) => {
      const [size] = numbersOf(answer) ?? []
      const wh = tupleOf(size, 2)
      return wh === undefined ? undefined : { w: wh[0] as number, h: wh[1] as number }
    },
    measure: options.measure,
  })
}
