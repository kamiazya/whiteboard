import {
  composeNode,
  groupPassages,
  mdastOptionsFor,
  nodeContentBounds,
  sketchInkFor,
} from './compose-node.js'
// Composes a canvas-render `Scene` from a `SpatialCanvas`. This is the
// single SpatialCanvas -> Scene builder shared by every consumer (Node
// export, the browser viewer) — see package-canvas-render.md's resolved
// decision. Process-internal (a value in, a value out), so per
// zod-schema-discipline no Zod schema is warranted.
//
// The markdown parser DEFAULTS to codec's `parseMarkdownBody` and stays
// overridable: every production caller passed that exact function, so the
// seam was seven identical lines, but layout tests parse with a stub for the
// same reason they measure with one. `appearance` is a genuinely injected
// `SpatialAppearanceResolver` (spatial-appearance.ts) — layout never chooses
// a color.
//
// Total by construction: canvas-render's own layout/routing entry points
// already degrade instead of throwing, and this module's one addition —
// calling `parseBody` on a `text` node's body — is wrapped so a markdown
// construct outside the caller's accepted subset degrades that one node's
// content to a literal text run instead of aborting the whole canvas.
//
// Emission order is DOCUMENT order (nodes in array order, shape then
// content per node, then edges), not sorted by position. Z-order is
// authored, not derived, so document order is the correct semantic; a
// (y, x, id) position sort would silently reorder authored z-order. Export
// reproducibility does not need a sort to hold: document order is already
// a total function of a deterministic canvas, so the same canvas renders
// the same SVG twice regardless.

import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { EdgeRoutingStyle, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode, isFrame } from '@kamiazya/whiteboard-model'
import type { VisualEdgesFacet } from '@kamiazya/whiteboard-plugin-visual'
import { resolveCanvasEdgeStyle, resolveEdgeOwnStyle } from '@kamiazya/whiteboard-plugin-visual'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type {
  DecorationContext,
  EdgeRouter,
  NodeDecoration,
  RenderContribution,
  ResolvedEdgeNode,
  RoutableElement,
  Scene,
  SceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { highlightCode } from '../highlight/lowlight.js'
import { canvasLegend } from '../legend/canvas-legend.js'
import { withReferenceSeams } from '../references/seams.js'
import { withDeclaredColours } from '../tags/declared-colours.js'
import { SPATIAL_THEME_GEOMETRY, type SpatialGeometry } from '../theme/spatial-geometry.js'
import { createThemedAppearance } from '../theme/theme-asset.js'
import { canvasTheme, resolveThemeTable, themeFace } from './canvas-theme.js'
import { composeComments, composeRegionOutlines, regionsOf } from './comments.js'
import { contributedRoute, resolveRouterTable } from './contributed-router.js'
import { flattenDrawnEdgePath } from './edges/edge-flatten.js'
import { computeEdgeJumps } from './edges/edge-jumps.js'
import { edgeLabelPlacement, labelObstacles } from './edges/edge-label-anchor.js'
import { assignEdgeAnchors, type EdgeAnchorPair, routeEdge } from './edges/spatial-edges.js'
import type { ResolvedLayoutOptions, SpatialLayoutOptions } from './layout-options.js'
import { outlineEntryPoint, type ShapeContribution, type ShapeTable } from './nodes/node-outline.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import { nodePassagesOf } from './passage-highlight.js'
import { composeProposals } from './proposals.js'

export {
  COMMENT_TEXT_MAX_WIDTH_PX,
  type CommentBodyLayoutOptions,
  layoutCommentBody,
} from './comment-body.js'
export { COMMENT_BUBBLE_OFFSET_PX } from './comment-placement.js'

/**
 * Resolves the effective geometry for one `layoutSpatialCanvas` call.
 * A non-finite or out-of-range override degrades to the shared default
 * field-by-field, keeping this function total rather than letting a bad
 * override propagate NaN/negative values into node/text geometry.
 */
function nonNegativeOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveGeometry(geometry: SpatialGeometry | undefined): SpatialGeometry {
  if (!geometry) return SPATIAL_THEME_GEOMETRY
  return {
    paddingPx: nonNegativeOr(geometry.paddingPx, SPATIAL_THEME_GEOMETRY.paddingPx),
    labelFontSizePx: positiveOr(geometry.labelFontSizePx, SPATIAL_THEME_GEOMETRY.labelFontSizePx),
    minContentWidthPx: nonNegativeOr(
      geometry.minContentWidthPx,
      SPATIAL_THEME_GEOMETRY.minContentWidthPx,
    ),
  }
}

/**
 * The `MdastLayoutOptions` every body layout in this module is built from —
 * one producer, so a seam added to `SpatialLayoutOptions` cannot reach a
 * text node's body and silently miss a file node's, which is exactly how
 * the fragment seams came to be wired on one surface only.
 */
function composeEdge(
  canvas: SpatialCanvas,
  edge: RoutableElement,
  options: ResolvedLayoutOptions,
  routingStyle: EdgeRoutingStyle | undefined,
  anchors: EdgeAnchorPair | undefined,
): ResolvedEdgeNode {
  // `routeEdge` already degrades a missing endpoint per canvas-render's own
  // documented contract — nothing further to catch here.
  //
  // The routing style rides on the canvas, which this function already has,
  // so honouring it costs no new plumbing through the consumers: editor,
  // export and viewer all pass the canvas and get the same routes from it.
  //
  // A contribution may claim this edge; a decline or a name it did not
  // register falls back to the built-in, never an error, so a document
  // written against another deployment's plugins still draws.
  const routed = pullEdgeOntoOutlines(
    contributedRoute(canvas, edge, options, anchors) ??
      routeEdge(canvas.nodes, edge, routingStyle, anchors),
    canvas,
    edge,
    options.nodeOutlines,
    options.shapeTable,
  )
  const appearance = options.appearance.resolveEdge(edge)
  const ink = sketchInkFor(edge.id, options, false)
  return {
    ...routed,
    ...(appearance === undefined ? {} : { appearance }),
    ...(ink === undefined ? {} : { ink }),
  }
}

type Point = { readonly x: number; readonly y: number }

/**
 * One END of a routed path: the point it terminates at, the point before it
 * (the approach an outline is entered along), and how to put a moved
 * terminal back. Both ends are the same operation on a path read from
 * opposite sides — `tidy-axis.ts` makes the same move for x and y.
 */
interface PathEnd {
  readonly terminal: (path: readonly Point[]) => Point | undefined
  readonly inward: (path: readonly Point[]) => Point | undefined
  readonly replace: (path: readonly Point[], terminal: Point) => readonly Point[]
}

const PATH_ENDS = {
  from: {
    terminal: (path) => path[0],
    inward: (path) => path[1],
    replace: (path, terminal) => [terminal, ...path.slice(1)],
  },
  to: {
    terminal: (path) => path.at(-1),
    inward: (path) => path.at(-2),
    replace: (path, terminal) => [...path.slice(0, -1), terminal],
  },
} satisfies Record<'from' | 'to', PathEnd>

/**
 * Pulls ONE end of a path onto the silhouette of the node it attaches to.
 * A free end has no node, and a node with no declared outline has nothing to
 * be pulled onto; either leaves the path as it was.
 */
function pullEndOntoOutline(
  path: readonly Point[],
  end: 'from' | 'to',
  edge: RoutableElement,
  canvas: SpatialCanvas,
  nodeOutlines: Readonly<Record<string, string>>,
  shapes: ShapeTable | undefined,
): readonly Point[] {
  const id = endNode(edge[end])
  const kind = id === undefined ? undefined : nodeOutlines[id]
  const node =
    kind === undefined ? undefined : canvas.nodes.find((candidate) => candidate.id === id)
  if (kind === undefined || node === undefined) return path
  const at = PATH_ENDS[end]
  const terminal = at.terminal(path)
  const inward = at.inward(path)
  if (terminal === undefined || inward === undefined) return path
  const box = { x: node.x, y: node.y, w: node.width, h: node.height }
  const pulled = outlineEntryPoint(kind, box, inward, terminal, shapes)
  // Compare coordinates, not object identity: relying on outlineEntryPoint
  // returning the very same object on its no-op paths is an unstated
  // contract, and a fresh-but-equal point must not rewrite the path (the
  // scene-diff scoreboard pins that untouched edges stay byte-identical).
  return pulled.x === terminal.x && pulled.y === terminal.y ? path : at.replace(path, pulled)
}

/**
 * A route terminates ON the endpoint's bbox border, which for every
 * inscribed outline is OUTSIDE the silhouette except at tangent points —
 * an arrowhead would float off an ellipse's shoulder. Each end whose node
 * declares an outline is pulled inward along its own approach segment via
 * `outlineEntryPoint`, AFTER routing: the router and its cost model keep
 * reading rects, so routing behaviour (and the routing scoreboard) is
 * untouched by construction.
 */
function pullEdgeOntoOutlines(
  routed: ResolvedEdgeNode,
  canvas: SpatialCanvas,
  edge: RoutableElement,
  nodeOutlines: Readonly<Record<string, string>> | undefined,
  shapes: ShapeTable | undefined,
): ResolvedEdgeNode {
  if (nodeOutlines === undefined || routed.path.length < 2) return routed
  let path: readonly Point[] = routed.path
  // The ends are independent: with three or more points each is entered along
  // its own segment, and on a two-point path both lie on one line, so either
  // is entered along that line whichever is pulled first (swapping the order
  // changes no test). `to` first is kept only because it is the order the
  // bytes were produced in — the entry search is iterative in floating point.
  for (const end of ['to', 'from'] as const) {
    path = pullEndOntoOutline(path, end, edge, canvas, nodeOutlines, shapes)
  }
  return path === routed.path ? routed : { ...routed, path: [...path] }
}

/**
 * Composes a centered label run for an edge that carries one. Returns
 * `undefined` for no label, an empty/whitespace-only label, or a
 * degenerate path — `layoutSpatialCanvas` stays total either way. The
 * anchor comes from `edgeLabelAnchor`, the same producer the editor's
 * inline label editor uses.
 */
function composeEdgeLabel(
  edge: RoutableElement,
  routed: ResolvedEdgeNode,
  options: ResolvedLayoutOptions,
  obstacles: ReturnType<typeof labelObstacles>, // what the label must not lie over
): TextRunNode | undefined {
  if (edge.label === undefined || edge.label.trim().length === 0) return undefined
  const labelAppearance = options.appearance.resolveLabel()
  const font = {
    family: labelAppearance.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal' as const,
    sizePx: options.geometry.labelFontSizePx,
  }
  const metrics = options.measure(edge.label, font)
  const size = { w: metrics.advanceWidth, h: metrics.ascent + metrics.descent }
  const center = edgeLabelPlacement(routed.path, size, obstacles, routed.rounded === true)
  if (!center) return undefined
  return {
    kind: 'textRun',
    bbox: { x: center.x - size.w / 2, y: center.y - size.h / 2, w: size.w, h: size.h },
    baseline: metrics.ascent,
    text: edge.label,
    appearance: { ...labelAppearance, fontSize: options.geometry.labelFontSizePx },
    annotates: { kind: 'edge', id: edge.id },
  }
}

/**
 * Composes a canvas-render `Scene` from a `SpatialCanvas`. Pure: takes the
 * already-read canvas plus injected measurer/body-parser/appearance, and
 * performs no I/O. Geometry is resolved exactly once here (see
 * `resolveGeometry`) and threaded to every helper as `ResolvedLayoutOptions`.
 */
export { fitSceneIntoBox } from './scale-scene.js'

export function layoutSpatialCanvas(canvas: SpatialCanvas, options: SpatialLayoutOptions): Scene {
  return layoutSpatialCanvasWithAnchors(canvas, options).scene
}

/**
 * `layoutSpatialCanvas` plus the edge-anchor map the layout itself routed
 * with. The anchor pass is the most expensive step of the whole layout, and
 * the editor's drag start needs exactly the committed anchors — so a caller
 * holding the scene must never have to re-run the pass to get them. Same
 * one-producer rule as `layoutSpatialEdges`: this IS the layout, not a
 * second computation beside it.
 */
export function layoutSpatialCanvasWithAnchors(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): { scene: Scene; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  // Intent first, so every reader below sees the same colours.
  const canvas = withDeclaredColours(stored, options.tagLibrary)
  return layoutSpatialCanvasInternal(canvas, {
    ...withSpatialReferenceSeams(options),
    ...resolveContributions(canvas, options),
    passagesByNode: groupPassages(nodePassagesOf(options.threads ?? [])),
    regionsByThread: regionsOf(options.threads ?? [], canvas),
    messagesByThread: new Map((options.threads ?? []).map((t) => [t.id, t.messages.length])),
    geometry: resolveGeometry(options.geometry),
    parseBody: options.parseBody ?? parseMarkdownBody,
    highlightCode: options.highlightCode ?? highlightCode,
    activeEmbedPath: new Set(options.embedPath ?? []),
    embedDepth: options.embedPath?.length ?? 0,
    fitToBox: true,
  })
}

/**
 * The extent a node's content occupies when NOTHING is trimmed to fit it.
 *
 * This is the question an auto-fit asks — "how big does this box have to be"
 * — and it is deliberately a named function rather than a layout option or a
 * degenerate-height trick. Laying a node out at `height: 1` and reading the
 * scene's bottom edge answers it too, but only because a box that small
 * cannot bound anything: the layout API cannot tell that probe apart from a
 * node someone really made 1px tall, so the escape hatch it needs was open
 * for every tiny node as well. A node that needs `h` of content is contained
 * by a height of `h + 2 * geometry.paddingPx`.
 *
 * Chrome is excluded (it spans the stored box by definition, so including it
 * could never report "the content is shorter than its box"), and so is a
 * label placed ABOVE the frame — that is not content in the box.
 */
export function naturalNodeContentSize(
  node: SpatialNode,
  options: SpatialLayoutOptions,
): { readonly w: number; readonly h: number } {
  const single: SpatialCanvas = { nodes: [node], edges: [] }
  // Through the same theme resolution a layout applies: a theme's font
  // changes what fits, and a caller sizing a node under a theme passes its
  // id as `style` (the single-node canvas carries no facet to read).
  const content = composeNode(
    node,
    withCanvasTheme(single, {
      ...withSpatialReferenceSeams(options),
      // A silhouette inscribes the box its content has to fit, so the natural
      // size of a shaped node is not the natural size of the rect around it.
      ...resolveContributions(single, options),
      // A natural size asks how big the box must be; a highlight adds no
      // extent beyond the words it sits under, so none is composed here.
      passagesByNode: new Map(),
      regionsByThread: new Map(),
      messagesByThread: new Map(),
      geometry: resolveGeometry(options.geometry),
      parseBody: options.parseBody ?? parseMarkdownBody,
      highlightCode: options.highlightCode ?? highlightCode,
      activeEmbedPath: new Set(),
      embedDepth: 0,
      fitToBox: false,
    }),
  ).filter(
    (entry): entry is Exclude<SceneNode, { kind: 'edge' }> =>
      entry.kind !== 'shape' && entry.kind !== 'edge' && entry.bbox.y >= node.y,
  )

  if (content.length === 0) return { w: 0, h: 0 }
  const right = Math.max(...content.map((entry) => entry.bbox.x + entry.bbox.w))
  const bottom = Math.max(...content.map((entry) => entry.bbox.y + entry.bbox.h))
  const padding = resolveGeometry(options.geometry).paddingPx
  return {
    w: Math.max(0, right - (node.x + padding)),
    h: Math.max(0, bottom - (node.y + padding)),
  }
}

/** `SpatialLayoutOptions` with the reference bundle applied — see `withReferenceSeams`. */
function withSpatialReferenceSeams(options: SpatialLayoutOptions): SpatialLayoutOptions {
  const applied = withReferenceSeams(options)
  const seams = options.references
  if (seams === undefined) return applied
  return {
    ...applied,
    resolveAlias: options.resolveAlias ?? seams.resolveAlias,
    resolveReference: options.resolveReference ?? seams.resolveReference,
  }
}

/** The embed path needs only the scene; the anchor map is per-top-level-canvas. */
function layoutSpatialCanvasInternalScene(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): Scene {
  return layoutSpatialCanvasInternal(canvas, resolved).scene
}

/** Badge geometry: a small corner mark, not content — fixed, not themed. */
/**
 * The context a decoration is given. `bounds` is the node's CONTENT box, so a
 * silhouette insets a decoration exactly as it insets text; `label` is the
 * resolved label appearance, so ink that should match the node's text can.
 */
export type { DecorationContext, NodeDecoration, RenderContribution }

/**
 * Everything a contribution set decides ABOUT ONE CANVAS — the set, its shape
 * table, and the silhouette each node resolves to — in ONE function, so an
 * entry point omitting a piece is a type error rather than a silent omission.
 *
 * `nodeOutlines` is here rather than beside each entry point because the edge
 * overlay proved the point: resolved for the committed layout and not for
 * `layoutSpatialEdges`, so an edge into a shaped node sat on the bbox border
 * for a whole drag and snapped onto the silhouette on drop. Both call sites
 * read as complete alone; only comparing them showed the gap.
 */
function resolveContributions(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): {
  contributions: readonly RenderContribution[]
  shapeTable: ShapeTable
  routerTable: Readonly<Record<string, EdgeRouter>>
  themeTable: Readonly<Record<string, ThemeTokens>>
  nodeOutlines: Readonly<Record<string, string>> | undefined
  explicitNodeOutlines: Readonly<Record<string, string>> | undefined
  baseAppearance: SpatialAppearanceResolver
  layoutNestedCanvas: ResolvedLayoutOptions['layoutNestedCanvas']
} {
  const contributions = options.renderContributions ?? [visualRenderContribution]
  return {
    contributions,
    // The composer's own entry, handed to the node composition that needs it
    // for a file embed and a body's `![[canvas]]` — see the field's own doc.
    layoutNestedCanvas: layoutSpatialCanvasInternalScene,
    shapeTable: resolveShapeTable(contributions),
    routerTable: resolveRouterTable(contributions),
    themeTable: resolveThemeTable(contributions),
    nodeOutlines: resolveNodeOutlines(canvas, options.nodeOutlines, contributions),
    explicitNodeOutlines: options.nodeOutlines,
    baseAppearance: options.appearance,
  }
}

/**
 * Resolves the theme for ONE canvas (ADR-0030 decision 5) and re-derives
 * everything that depends on it: the appearance resolver, and the
 * silhouettes (a theme's default shape fills in where a node's facet is
 * silent). Called at every nesting level from the canvas being laid out —
 * never threaded down as an option, which is the shape that lets an outer
 * document's setting win over an embedded canvas's own.
 */
function withCanvasTheme(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): ResolvedLayoutOptions {
  const activeTheme = canvasTheme(canvas, resolved)
  const appearance =
    activeTheme === undefined
      ? resolved.baseAppearance
      : createThemedAppearance({
          tokens: activeTheme.tokens,
          mode: resolved.baseAppearance.mode ?? 'light',
          fontFamily: themeFace(activeTheme.tokens.fontFamily, resolved),
        })
  // The inherited theme is REPLACED, never merged under: a child naming a
  // theme this build does not carry draws clean, so it must not keep the
  // host's ink and routing defaults beside its own clean paint.
  const { activeTheme: _inherited, ...rest } = resolved
  return {
    ...rest,
    appearance,
    ...(activeTheme === undefined ? {} : { activeTheme }),
    nodeOutlines: resolveNodeOutlines(
      canvas,
      resolved.explicitNodeOutlines,
      resolved.contributions,
      activeTheme?.tokens.defaults.nodeShape,
    ),
  }
}

/** The composed shape table a contribution set resolves to — what the SVG
 *  backend must be handed alongside the scene. */
export function resolveShapeTable(contributions: readonly RenderContribution[]): ShapeTable {
  const table: Record<string, ShapeContribution> = {}
  for (const contribution of contributions) {
    for (const [name, shape] of Object.entries(contribution.shapes ?? {})) {
      table[`${contribution.namespace}.${name}`] = shape
    }
  }
  return table
}

function composeDecorations(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const decorations = options.contributions.flatMap((c) => c.decorations ?? [])
  if (decorations.length === 0) return []
  const context: DecorationContext = {
    bounds: nodeContentBounds(node, options),
    label: options.appearance.resolveLabel(),
  }
  return decorations.flatMap((decorate) => decorate(node, context))
}

/**
 * Containers paint BEHIND what they hold, whatever order the canvas lists
 * them in: every group first, a larger one before a smaller (an outer group
 * before the one inside it), then everything else in stored order.
 * Stored order is a map's id order, not the order a caller wrote, so a group
 * whose id sorted after a member's painted over it once it had a colour —
 * four of eleven boxes vanished from a diagram whose grader, reading the
 * store, passed it. Equal boxes keep their stored order (the sort is
 * stable). Exported so the web app's hit-test index reads the same order.
 */
export function paintOrderOf(nodes: readonly SpatialNode[]): readonly SpatialNode[] {
  const groups = nodes
    .filter((node) => isFrame(node))
    .sort((a, b) => b.width * b.height - a.width * a.height)
  return [...groups, ...nodes.filter((node) => !isFrame(node))]
}

function layoutSpatialCanvasInternal(
  canvas: SpatialCanvas,
  incoming: ResolvedLayoutOptions,
): { scene: Scene; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  const resolved = withCanvasTheme(canvas, incoming)
  const nodeContent = paintOrderOf(canvas.nodes).flatMap((node) => [
    ...composeNode(node, resolved),
    ...composeDecorations(node, resolved),
  ])
  const { content, anchors } = composeEdgesAndLabels(canvas, resolved)
  // Comments LAST: the annotation layer paints above every node and edge,
  // which a flat document-order paint list can only express by position —
  // and after the edges are ROUTED, since a comment about an edge is pinned
  // on the path the edge was actually drawn along.
  const edgePaths = new Map<string, readonly { x: number; y: number }[]>()
  for (const node of content) {
    if (node.kind === 'edge' && node.id !== undefined) {
      edgePaths.set(node.id, flattenDrawnEdgePath(node.path, node.jumps, node.rounded === true))
    }
  }
  // Region outlines go under the pins, over everything they enclose.
  const regionContent = composeRegionOutlines(resolved)
  const commentContent = composeComments(
    canvas,
    resolved,
    (id) => edgePaths.get(id),
    mdastOptionsFor,
  )
  const proposalContent = composeProposals(
    canvas,
    resolved,
    (id) => edgePaths.get(id),
    mdastOptionsFor,
  )
  // The legend is the layout's answer, attached here and not in a
  // miniature: the reader of an embedded canvas has the host's corner.
  const legend = canvasLegend(canvas, resolved.appearance)
  return {
    scene: {
      nodes: [...nodeContent, ...content, ...regionContent, ...commentContent, ...proposalContent],
      ...(legend === undefined ? {} : { legend }),
    },
    anchors,
  }
}

function composeEdgesAndLabels(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): { content: SceneNode[]; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  // One anchor pass for the whole edge set: fan-out needs to see every end
  // sharing a side, which a per-edge route cannot.
  // Facet-aware by DEFAULT (visual.edges/v0): resolution lives here rather
  // than at the call sites for the
  // same reason the tokeniser default does — every surface that lays a
  // canvas out wants it, and the one that forgets draws different routes.
  // The theme's routing is a DEFAULT under the canvas's own facet (ADR-0030
  // decision 4): it fills in only where `visual.edges` says nothing.
  const explicitStyle = resolveCanvasEdgeStyle(canvas)
  const themeRouting = resolved.activeTheme?.tokens.defaults.edgeRouting
  const edgeStyle = {
    ...explicitStyle,
    ...(explicitStyle.style === undefined && themeRouting !== undefined
      ? { style: themeRouting }
      : {}),
  }
  // The SAME facet asked of one edge narrows the board's answer, field by
  // field (ADR-0013's edge slot). Memoised per id because the side-choice
  // search asks for an edge's style many times per layout, and each ask
  // would otherwise re-resolve and re-parse a stored payload.
  const ownStyles = new Map<string, VisualEdgesFacet>()
  const ownStyleOf = (edge: RoutableElement): VisualEdgesFacet => {
    const hit = ownStyles.get(edge.id)
    if (hit !== undefined) return hit
    const own = resolveEdgeOwnStyle(edge)
    ownStyles.set(edge.id, own)
    return own
  }
  // The side pass runs BEFORE any router does, over the whole edge set, so
  // it works in the built-in vocabulary; a contributed router receives the
  // sides it chose rather than being bound by them.
  const styleOf = (edge: RoutableElement): EdgeRoutingStyle =>
    ownStyleOf(edge).routing ?? edgeStyle.style ?? 'straight'
  // Edges AND lines, through one pipeline: the route between two places is the
  // same question whichever the element is, and the anchoring pass has to see
  // every element or two of them will pick the same side of one box.
  const routable: readonly RoutableElement[] = [...canvas.edges, ...(canvas.lines ?? [])]
  const anchors = assignEdgeAnchors(canvas.nodes, routable, styleOf, resolved.edgeSideOverrides)
  const routedEdges = routable.map((edge) =>
    composeEdge(canvas, edge, resolved, styleOf(edge), anchors.get(edge.id)),
  )
  // A jump is drawn on the LATER edge of a crossing pair, so "does this edge
  // hop" is asked of the edge that would draw the arc. Crossings are still
  // computed over EVERY edge — who crosses whom is geometry, and an edge
  // that wants no arcs of its own is still something its neighbours cross.
  const hopsOf = (edge: RoutableElement): boolean =>
    (ownStyleOf(edge).lineJumps ?? edgeStyle.lineJumps ?? 'none') === 'arc'
  const anyHops = routable.some(hopsOf)
  const jumpsByEdge = anyHops ? computeEdgeJumps(routedEdges) : undefined
  const edgeContent =
    jumpsByEdge === undefined
      ? routedEdges
      : routedEdges.map((edge, index) => {
          const jumps = jumpsByEdge.get(edge.id)
          const source = routable[index]
          if (jumps === undefined || source === undefined || !hopsOf(source)) return edge
          return { ...edge, jumps }
        })
  const obstacles = labelObstacles(canvas.nodes)
  const labelContent = routable
    .map((edge, index) => composeEdgeLabel(edge, edgeContent[index]!, resolved, obstacles))
    .filter((label): label is TextRunNode => label !== undefined)
  return { content: [...edgeContent, ...labelContent], anchors }
}

/**
 * The edge-and-label suffix of `layoutSpatialCanvas`'s scene, on its own:
 * routing, line jumps, and centered labels through the exact code path the
 * full layout uses, without laying out any node content. This exists for a
 * consumer that already has the node layer rendered and needs ONLY the
 * edges recomputed against updated node positions (the editor's live drag
 * overlay) — a second edge pipeline there would drift from the committed
 * result, which is the one-producer-per-geometry rule this export upholds.
 */
export function layoutSpatialEdges(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): SceneNode[] {
  // Through the same theme resolution the full layout applies to this
  // canvas: the ink, the routing default and the paint an edge takes are
  // the theme's, and a second entry point that skipped it drew a live drag
  // crisp and straight over a pencilled, curved committed render. The
  // library's colour by intent is the same kind of thing, applied first.
  const canvas = withDeclaredColours(stored, options.tagLibrary)
  return composeEdgesAndLabels(
    canvas,
    withCanvasTheme(canvas, {
      ...withSpatialReferenceSeams(options),
      ...resolveContributions(canvas, options),
      passagesByNode: new Map(),
      regionsByThread: new Map(),
      messagesByThread: new Map(),
      geometry: resolveGeometry(options.geometry),
      parseBody: options.parseBody ?? parseMarkdownBody,
      highlightCode: options.highlightCode ?? highlightCode,
      activeEmbedPath: new Set(),
      embedDepth: 0,
      fitToBox: true,
    }),
  ).content
}

/**
 * The effective silhouette per node, as a NAMESPACED shape id.
 *
 * The id is composed, never stored: a contribution's reader answers a BARE
 * kind and its namespace prefixes it, so `visual`'s reader returning `diamond`
 * resolves `visual.diamond`. A document therefore cannot name another
 * plugin's geometry — no payload it can hold carries a namespace.
 *
 * An explicit `nodeOutlines` entry still overrides for that node, and is
 * already a full id.
 *
 * Later contributions win a contested node, which is the only ordering rule
 * this needs: a silhouette is one answer where a decoration is a stack.
 */
function resolveNodeOutlines(
  canvas: SpatialCanvas,
  explicit: Readonly<Record<string, string>> | undefined,
  contributions: readonly RenderContribution[],
  defaultShape?: string,
): Readonly<Record<string, string>> | undefined {
  let fromFacets: Record<string, string> | undefined
  for (const node of canvas.nodes) {
    let chosen: string | undefined
    for (const contribution of contributions) {
      const kind = contribution.readShape?.(node)
      if (kind === undefined) continue
      chosen = `${contribution.namespace}.${kind}`
    }
    // The theme's default is an already-namespaced id, and it fills in only
    // where the node's own facet is silent (ADR-0030 decision 4). A group is
    // a frame around other nodes, never a shaped thing itself.
    if (chosen === undefined && defaultShape !== undefined && !isFrame(node)) {
      chosen = defaultShape
    }
    if (chosen === undefined) continue
    fromFacets ??= {}
    fromFacets[node.id] = chosen
  }
  if (fromFacets === undefined) return explicit
  return explicit === undefined ? fromFacets : { ...fromFacets, ...explicit }
}

// The overlay layers and the options vocabulary live in their own modules
// now (comments.ts, proposals.ts, layout-options.ts). They are re-exported
// here because this file has been the package's layout barrel since before
// they were split out, and a move that also rewrote every importer would be
// two changes in one diff.
export {
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  COMMENT_PIN_COUNT_FONT_PX,
  COMMENT_PIN_SIZE_PX,
  commentAnchor,
  type EdgePathLookup,
} from './comments.js'
export type {
  FacetCardData,
  ResolvedReference,
  SpatialContentCache,
  SpatialLayoutDegradation,
  SpatialLayoutOptions,
  SpatialRenderStyle,
} from './layout-options.js'
export { spatialRenderStyleSchema } from './layout-options.js'
