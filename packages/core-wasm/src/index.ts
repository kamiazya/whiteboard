// The `#glue` declaration travels with this module, so a consumer's `tsc`
// (canvas-render compiles this source through the workspace link) sees it
// with no staged artifact.
/// <reference path="./glue.d.ts" />
import type {
  EdgeRoutingStyle,
  ExtensionFacets,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import {
  type FacetBucketResult,
  type FacetErrors,
  type FacetGlue,
  type FacetWriteTarget,
  facetBucketCheck,
  type StoredStencilLibrary,
} from './facet-write.js'
import { EDGE_ROUTE_LAYOUT_CAPS, type RefusalCode } from './generated/input-caps.js'
import {
  parseSpatial,
  type SpatialErrors,
  type SpatialGlue,
  type SpatialIssue,
  type SpatialMode,
  type SpatialParseResult,
  serializeSpatial,
} from './json-canvas.js'
import {
  type LayoutAnswer,
  type LayoutGlue,
  type LayoutRequest,
  layoutSpatialCanvas,
} from './layout.js'
import {
  type OkfDocument,
  type OkfErrors,
  type OkfGlue,
  type OkfParseResult,
  parseOkf,
  serializeOkf,
} from './okf.js'
import type { UnwritableIssue } from './okf-unsafe.js'
import type { AnchorPair, LabelRect, RoutingBudget, SideOverride } from './types.js'
import { encodeLayout, sideAt } from './wire.js'

/** The glue surface the shim calls: the `#glue` module's own type. */
export type CoreGlue = typeof import('#glue')

/** The ABI this shim was written against; an artifact speaking another is refused at init. */
export const EXPECTED_ABI = '21'

/**
 * What the test lanes' oracle build (`oracle-surface`: the shipped build plus
 * per-module test exports) reports. Its production exports are the shipped
 * ones, so the shim accepts it; the reverse is the test lanes' to refuse,
 * since their exports are absent from a shipped artifact.
 */
export const ORACLE_ABI = `${EXPECTED_ABI}+oracle-surface`

/** The artifact speaks another ABI than this shim: the two came from different commits. */
export class CoreAbiMismatch extends Error {
  constructor(readonly found: string) {
    super(`the wasm artifact speaks ABI ${found}, this shim ${EXPECTED_ABI}; rebuild it`)
    this.name = 'CoreAbiMismatch'
  }
}

/**
 * An operation refused its input, with the registry's refusal code:
 * `input-too-large` when the encoded wire is past the entry's caps in
 * `crates/input-caps.json`, refused here before the artifact is called, as
 * the export would refuse it; `malformed` when the input is not one the shim
 * sends (a document the wire does not carry) or the artifact's answer cannot be accounted for, which for a wire
 * this shim built is a shim defect. A composition root answers either from
 * the TypeScript.
 */
export class CoreInputRefused extends Error {
  constructor(
    readonly operation: string,
    readonly code: RefusalCode,
    /** What kind of input earned the refusal, when the artifact says (`lone-surrogate`, `too-deep`, ...). */
    readonly detail?: string,
  ) {
    super(`${operation} refused its input: ${code}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'CoreInputRefused'
  }
}

/**
 * A frontmatter value has no YAML spelling. `issues` name each place, with
 * the TypeScript's own words, so a root throws what `serializeOkf` throws
 * (`OkfNotYamlSafeError`) from the same list.
 */
export class CoreOkfUnwritable extends Error {
  constructor(readonly issues: readonly UnwritableIssue[]) {
    super(
      `serializeOkf: the frontmatter has no YAML spelling: ${issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
    this.name = 'CoreOkfUnwritable'
  }
}

/**
 * The strict JSON Canvas writer's re-validation refused what it wrote. `issues`
 * name each place, so a root throws what `serializeSpatial` throws (a
 * `ZodError`) from the same list.
 */
export class CoreSpatialInvalid extends Error {
  constructor(readonly issues: readonly SpatialIssue[]) {
    super(
      `serializeSpatial: the document failed JSON Canvas validation: ${issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
    this.name = 'CoreSpatialInvalid'
  }
}

/** One layout's routes, in input order, and the anchors the search settled, by edge id. */
interface RoutedLayout {
  readonly routes: ResolvedEdgeNode[]
  readonly anchors: ReadonlyMap<string, AnchorPair>
}

/** An initialised core: one call per user operation (QR-22b). */
export interface Core {
  /**
   * One layout's edge routing, as canvas-render's composer runs it between
   * `assignEdgeAnchors` and its per-edge `routeEdge`: every edge of `edges`
   * routed in order, on `budget`, whose four accounts are written back,
   * with the anchors the composer hands on to the editor.
   */
  routeLayout(
    nodes: readonly SpatialNode[],
    edges: readonly RoutableElement[],
    styleOf: (edge: RoutableElement) => EdgeRoutingStyle,
    overrides: ReadonlyMap<string, SideOverride> | undefined,
    budget: RoutingBudget,
    labels: readonly LabelRect[],
  ): RoutedLayout

  /**
   * `parseOkf` of a whole document. Only its head crosses, the fences and the
   * frontmatter. Throws `CoreInputRefused` for a head past the entry's caps,
   * which a root answers from the TypeScript.
   */
  parseOkf(text: string): OkfParseResult

  /**
   * `serializeOkf` of a document: the artifact writes the frontmatter and
   * the body is appended here. Throws `CoreOkfUnwritable` for a value with no
   * YAML spelling, which a root answers as the TypeScript does, and
   * `CoreInputRefused` for a document the wire does not carry, which a root
   * answers from the TypeScript.
   */
  serializeOkf(doc: OkfDocument): string

  /**
   * `parseSpatial` of a whole text. Throws `CoreInputRefused` for a text the
   * artifact does not read (past its cap, a lone surrogate, nesting past its
   * reader, a link whose host needs tables it does not carry), which a root
   * answers from the TypeScript.
   */
  parseSpatial(text: string): SpatialParseResult

  /**
   * `serializeSpatial` of a canvas. Throws `CoreSpatialInvalid` where the
   * strict mode's validation refuses what it wrote, and `CoreInputRefused` for
   * a canvas the artifact does not write, which a root answers from the
   * TypeScript.
   */
  serializeSpatial(canvas: SpatialCanvas, mode: SpatialMode): string

  /**
   * `partitionFacetWrites` and the stencil library's refusal, for a write that
   * targets `target`: the sets and deletions of `bucket`, or the first key
   * refused with the stage and what it says. `library` is the workspace's
   * stored stencils, passed for a bucket that writes a stencil. Throws
   * `CoreInputRefused` for a call the artifact does not answer (past its caps,
   * a value the wire does not carry), which a root answers from the
   * TypeScript.
   */
  facetBucketCheck(
    target: FacetWriteTarget,
    bucket: ExtensionFacets | undefined,
    library?: StoredStencilLibrary,
  ): FacetBucketResult

  /**
   * `layoutSpatialCanvasWithAnchors` of a request canvas-render built: the
   * scene, the anchors and the degradations, or the class of what the core
   * declined (an input past its caps, or one it cannot answer exactly as the
   * TypeScript would), which a root answers from the TypeScript. Throws
   * `CoreInputRefused` for a request the wire does not carry or an answer
   * that is not one.
   */
  layoutSpatialCanvas(request: LayoutRequest): LayoutAnswer
}

const ends = ['none', 'arrow'] as const

/** One anchor entry of 14 numbers, as `edge_assign_anchors` answers it. */
function anchorAt(out: Float64Array, at: number): AnchorPair {
  const point = (i: number) =>
    out[i] === 1 ? { x: out[i + 1] as number, y: out[i + 2] as number } : undefined
  const from = point(at + 1)
  const to = point(at + 4)
  const fromSide = sideAt(out[at + 11] as number)
  const toSide = sideAt(out[at + 12] as number)
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(out[at + 7] === 1 ? { fromLaneDepth: out[at + 8] as number } : {}),
    ...(out[at + 9] === 1 ? { toLaneDepth: out[at + 10] as number } : {}),
    ...(fromSide === undefined ? {} : { fromSide }),
    ...(toSide === undefined ? {} : { toSide }),
    ...(out[at + 13] === 1 ? { around: true as const } : {}),
  }
}

const ANCHOR_WIDTH = 14

/**
 * The routes and anchors in `out`, or undefined when it does not hold
 * exactly one route per edge and whole anchor entries naming known edges.
 */
function decodeLayout(
  out: Float64Array,
  edges: readonly RoutableElement[],
  edgeIds: readonly string[],
): RoutedLayout | undefined {
  if (out.length < 5 || out[4] !== edges.length) return undefined
  let at = 5
  const routes: ResolvedEdgeNode[] = []
  for (const edge of edges) {
    const route = routeAt(out, at, edge.id)
    if (route === undefined) return undefined
    routes.push(route)
    at += 6 + 2 * route.path.length
  }
  const count = out[at] ?? Number.NaN
  at += 1
  // Every number accounted for: a garbled answer is refused, not half read.
  if (!Number.isInteger(count) || at + count * ANCHOR_WIDTH !== out.length) return undefined
  const anchors = new Map<string, AnchorPair>()
  for (let i = 0; i < count; i++, at += ANCHOR_WIDTH) {
    const id = edgeIds[out[at] as number]
    const sides = [out[at + 11], out[at + 12]]
    if (id === undefined || !sides.every((s) => s === -1 || sideAt(s as number) !== undefined)) {
      return undefined
    }
    anchors.set(id, anchorAt(out, at))
  }
  return { routes, anchors }
}

const isFlag = (v: number | undefined): v is 0 | 1 => v === 0 || v === 1

/**
 * One route at `at`, or undefined when any of its numbers is out of range:
 * a side that names none, an end or a rounding flag past 0/1, or a point
 * count that is not a whole number the answer has room for. Checked before
 * anything is allocated, since the count is the artifact's word.
 */
function routeAt(out: Float64Array, at: number, id: string): ResolvedEdgeNode | undefined {
  const [rounded, from, to, fromEnd, toEnd, n] = out.subarray(at, at + 6)
  const fromSide = sideAt(from as number)
  const toSide = sideAt(to as number)
  if (fromSide === undefined || toSide === undefined) return undefined
  if (!isFlag(rounded) || !isFlag(fromEnd) || !isFlag(toEnd)) return undefined
  if (n === undefined || !Number.isInteger(n) || n < 0 || at + 6 + 2 * n > out.length) {
    return undefined
  }
  const path = Array.from({ length: n }, (_, i) => ({
    x: out[at + 6 + 2 * i] as number,
    y: out[at + 7 + 2 * i] as number,
  }))
  return {
    kind: 'edge',
    id,
    path,
    ...(rounded === 1 ? { rounded: true as const } : {}),
    fromSide,
    toSide,
    fromEnd: ends[fromEnd],
    toEnd: ends[toEnd],
  }
}

/**
 * A core over glue that is already loaded, initialised from `source` (the
 * artifact's bytes or a compiled module the composition root holds).
 * Synchronous, for a root that has the glue in hand, such as a worker.
 */
export function coreFrom(glue: CoreGlue, source: BufferSource | WebAssembly.Module): Core {
  glue.initSync({ module: source })
  const abi = glue.abi_version()
  if (abi !== EXPECTED_ABI && abi !== ORACLE_ABI) throw new CoreAbiMismatch(abi)
  const okf: OkfGlue = glue
  const spatial: SpatialGlue = glue
  const facets: FacetGlue = glue
  const layout: LayoutGlue = glue
  const errors: OkfErrors & SpatialErrors & FacetErrors = {
    refused: (operation, code, detail) => new CoreInputRefused(operation, code, detail),
    unwritable: (issues) => new CoreOkfUnwritable(issues),
    invalid: (issues) => new CoreSpatialInvalid(issues),
  }
  return {
    parseSpatial: (text) => parseSpatial(spatial, errors, text),
    serializeSpatial: (canvas, mode) => serializeSpatial(spatial, errors, canvas, mode),
    facetBucketCheck: (target, bucket, library) =>
      facetBucketCheck(facets, errors, target, bucket, library),
    layoutSpatialCanvas: (request) => layoutSpatialCanvas(layout, errors, request),
    parseOkf: (text) => parseOkf(okf, errors, text),
    serializeOkf: (doc) => serializeOkf(okf, errors, doc),
    routeLayout(nodes, edges, styleOf, overrides, budget, labels) {
      const wire = encodeLayout(nodes, edges, styleOf, overrides, budget, labels)
      if (wire.input.byteLength > EDGE_ROUTE_LAYOUT_CAPS.maxBytes) {
        throw new CoreInputRefused('edge_route_layout', 'input-too-large')
      }
      const out = glue.edge_route_layout(wire.input)
      const routed = decodeLayout(out, edges, wire.edgeIds)
      if (routed === undefined) throw new CoreInputRefused('edge_route_layout', 'malformed')
      budget.grid = out[0] as number
      budget.pairs = out[1] as number
      budget.trials = out[2] as number
      budget.repairs = out[3] as number
      return routed
    },
  }
}
