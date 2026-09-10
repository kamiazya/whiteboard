/**
 * A node's silhouette and an edge's line, drawn: crisp geometry from the
 * shared outline decomposition, or the pencilled passes the ink module
 * hands back, each with the halo a glowing appearance asks for. The one
 * place the backend draws a shape from, so a silhouette kind added to
 * `node-outline.ts` is drawn here and nowhere else.
 */
import { edgeArrowPolygons } from '../edge-arrows.js'
import { GLOW_STD_DEVIATION_RATIO } from '../layout/ink/glow.js'
import { sketchEdge, sketchShape } from '../layout/ink/sketch.js'
import { nodeOutline, type ShapeTable } from '../layout/nodes/node-outline.js'
import type {
  Appearance,
  BoundingBox,
  ResolvedEdgeNode,
  SceneInk,
  ShapeSceneNode,
} from '../scene-graph.js'
import type { IconTable } from './backend.js'
import { formatCoord } from './format.js'
import {
  appearanceAttrs,
  DROP_SHADOW_DEFS,
  DROP_SHADOW_ID,
  idToken,
  isFiniteBox,
  isNonNegativeLength,
  isPositiveLength,
  PRESENTATION,
  pointsAttr,
  rectAttrs,
} from './paint.js'
import { el, type SvgChild, type SvgDef, type SvgVNode, withDefs } from './vnode.js'

/**
 * The resolution inputs a render pass carries: tables merged over this
 * package's built-in ones. One object rather than a positional argument each,
 * because every one of them threads through the same eight recursive call
 * sites and a second positional parameter is how the third gets forgotten.
 */
export interface ResolveTables {
  readonly icons?: IconTable
  readonly shapes?: ShapeTable
  /**
   * The user-space region every glow filter in this document declares —
   * the scene's bounds, which already include each halo's reach. Lazy,
   * because most scenes glow nowhere and the walk should cost them nothing.
   */
  readonly glowRegion?: () => BoundingBox
}

/**
 * The filter a glowing element references, and its definition: a Gaussian
 * blur of the element merged twice under the element itself (twice, so the
 * halo has body without a flood colour — it is the element's own paint).
 * One definition per (radius, region); the id derives from both, so a
 * repeated id across inline-injected SVGs is byte-identical by construction.
 */
export function glowOf(
  appearance: Appearance | undefined,
  tables: ResolveTables | undefined,
): { readonly filter?: string; readonly defs: ReadonlyArray<SvgDef> } {
  const radius = appearance?.glow?.radiusPx
  if (!isNonNegativeLength(radius) || radius === 0 || tables?.glowRegion === undefined) {
    return { defs: [] }
  }
  const region = tables.glowRegion()
  const regionKey = [region.x, region.y, region.w, region.h].map(formatCoord).join(',')
  const id = `wb-glow-${formatCoord(radius)}-${idToken(regionKey)}`
  const def: SvgDef = {
    id,
    node: el(
      'filter',
      {
        id,
        filterUnits: 'userSpaceOnUse',
        x: region.x,
        y: region.y,
        width: region.w,
        height: region.h,
      },
      [
        el('feGaussianBlur', { stdDeviation: radius * GLOW_STD_DEVIATION_RATIO, result: 'blur' }),
        el('feMerge', undefined, [
          el('feMergeNode', { in: 'blur' }),
          el('feMergeNode', { in: 'blur' }),
          el('feMergeNode', { in: 'SourceGraphic' }),
        ]),
      ],
    ),
  }
  return { filter: `url(#${id})`, defs: [def] }
}

/**
 * The box chrome of a spatial canvas node. A non-finite bbox field is a
 * layout bug this package must not crash on — it renders as nothing rather
 * than reaching `formatCoord`, which throws by contract.
 */
export function renderShape(node: ShapeSceneNode, tables?: ResolveTables): SvgChild {
  if (!isFiniteBox(node.bbox)) return []
  if (node.ink?.style === 'sketch') return renderSketchShape(node, node.ink, tables)
  return renderCrispShape(node, tables)
}

/** Presence-only: attach a glow's filter reference and definition to an element. */
export function withGlow(element: SvgVNode, glow: ReturnType<typeof glowOf>): SvgChild {
  if (glow.filter === undefined) return element
  return withDefs({ ...element, attrs: { ...element.attrs, filter: glow.filter } }, glow.defs)
}

/**
 * A pencilled node: the flat fill (or hatch lines) as an underlay, then the
 * strokes the shared decomposition hands back, round-capped so the passes
 * read as one pencil line. Comment chrome never arrives here — the layout
 * inks document content only — so the drop-shadow branch stays crisp.
 */
function renderSketchShape(node: ShapeSceneNode, ink: SceneInk, tables?: ResolveTables): SvgChild {
  const outline =
    node.shape === undefined ? null : nodeOutline(node.shape, node.bbox, tables?.shapes)
  const strokes = sketchShape(outline, node.bbox, ink.seed, { hatch: ink.fill === 'hatch' })
  const paint = appearanceAttrs(node.appearance)
  const strokeAttrs = {
    fill: 'none',
    stroke: paint.stroke,
    'stroke-width': paint['stroke-width'],
    'stroke-opacity': paint['stroke-opacity'],
    'stroke-dasharray': paint['stroke-dasharray'],
  }
  const underlay: SvgChild =
    strokes.hatch !== undefined
      ? el(
          'g',
          { 'stroke-linecap': 'round' },
          strokes.hatch.map((d) =>
            el('path', {
              d,
              fill: 'none',
              stroke: paint.stroke,
              'stroke-width': HATCH_STROKE_WIDTH,
              'stroke-opacity': HATCH_OPACITY,
            }),
          ),
        )
      : paint.fill === undefined || paint.fill === 'none'
        ? []
        : // The crisp silhouette with its stroke removed: a hand draws no
          // 6px fillet, so the rect underlay drops its radius too.
          renderCrispShape(
            {
              ...node,
              radius: undefined,
              appearance: {
                fill: paint.fill,
                ...(paint['fill-opacity'] === undefined
                  ? {}
                  : { fillOpacity: paint['fill-opacity'] }),
              },
            },
            tables,
          )
  const outlineStrokes = el(
    'g',
    { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    strokes.strokes.map((d) => el('path', { d, ...strokeAttrs })),
  )
  return [underlay, withGlow(outlineStrokes, glowOf(node.appearance, tables))]
}

const HATCH_STROKE_WIDTH = 0.9
const HATCH_OPACITY = 0.75

function renderCrispShape(node: ShapeSceneNode, tables?: ResolveTables): SvgChild {
  // Non-rect silhouettes come from the shared decomposition (one producer
  // for drawing and hit-testing — layout/nodes/node-outline.ts); an absent
  // `shape` stays the historic rect byte-for-byte.
  if (node.shape !== undefined) {
    const outline = nodeOutline(node.shape, node.bbox, tables?.shapes)
    // A null outline here can only mean the id resolves to nothing — the
    // non-finite box is already handled above — so the node falls back to
    // its rect. Drawing NOTHING was correct while ids came from a closed
    // union and null meant a degenerate box; once a document can name a
    // shape this build does not carry, it made the node disappear.
    if (outline === null) return renderChromeRect(node, tables)
    const glow = glowOf(node.appearance, tables)
    switch (outline.kind) {
      case 'ellipse':
        return withGlow(
          el('ellipse', {
            cx: outline.cx,
            cy: outline.cy,
            rx: outline.rx,
            ry: outline.ry,
            ...appearanceAttrs(node.appearance),
          }),
          glow,
        )
      case 'polygon':
        return withGlow(
          el('polygon', {
            points: pointsAttr(outline.points),
            ...appearanceAttrs(node.appearance),
          }),
          glow,
        )
      case 'cylinder': {
        const { x, y, w, h, ry } = outline
        const rx = w / 2
        const top = y + ry
        const bottom = y + h - ry
        const arc = (sweep: 0 | 1, toX: number, atY: number) =>
          `A ${formatCoord(rx)} ${formatCoord(ry)} 0 0 ${sweep} ${formatCoord(toX)} ${formatCoord(atY)}`
        const silhouette = [
          `M ${formatCoord(x)} ${formatCoord(top)}`,
          arc(1, x + w, top),
          `L ${formatCoord(x + w)} ${formatCoord(bottom)}`,
          arc(1, x, bottom),
          'Z',
        ].join(' ')
        // The lid is the visible lower half of the top cap — stroke-only
        // ink INSIDE the silhouette, so bounds/hit keep reading the bbox.
        const lid = [`M ${formatCoord(x)} ${formatCoord(top)}`, arc(0, x + w, top)].join(' ')
        const paint = appearanceAttrs(node.appearance)
        const parts = [
          el('path', { d: silhouette, ...paint }),
          el('path', {
            d: lid,
            fill: 'none',
            stroke: paint.stroke,
            'stroke-width': paint['stroke-width'],
            'stroke-opacity': paint['stroke-opacity'],
          }),
        ]
        // Two siblings, byte-for-byte as before, unless a glow needs the pair
        // filtered as one — a halo per part would double up along the lid.
        return glow.filter === undefined ? parts : withGlow(el('g', undefined, parts), glow)
      }
    }
  }
  return renderChromeRect(node, tables)
}

/**
 * A pencilled edge: the drawn polyline (rounded corners and hops included,
 * through the same flattening the hit-test uses) in two bowed passes, and
 * each arrowhead as two wing strokes — no marker, since a crisp triangle on
 * a pencil line is the one thing that reads as two styles at once.
 */
export function renderSketchEdge(
  node: ResolvedEdgeNode,
  ink: SceneInk,
  tables?: ResolveTables,
): SvgChild {
  const strokes = sketchEdge(node.path, ink.seed, {
    arrows: edgeArrowPolygons(node),
    rounded: node.rounded === true,
    jumps: node.jumps ?? [],
  })
  const paint = appearanceAttrs(node.appearance)
  return withGlow(
    el(
      'g',
      { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      strokes.strokes.map((d) =>
        el('path', {
          d,
          fill: 'none',
          stroke: paint.stroke,
          'stroke-width': paint['stroke-width'],
          'stroke-opacity': paint['stroke-opacity'],
          'stroke-dasharray': paint['stroke-dasharray'],
          role: PRESENTATION,
        }),
      ),
    ),
    glowOf(node.appearance, tables),
  )
}

/** The historic rect, byte-for-byte — also what a node falls back to when its
 *  shape id resolves to nothing. */
function renderChromeRect(node: ShapeSceneNode, tables?: ResolveTables): SvgChild {
  const glow = glowOf(node.appearance, tables)
  const rect = el('rect', {
    ...rectAttrs(node.bbox),
    rx: isPositiveLength(node.radius) ? node.radius : undefined,
    ...appearanceAttrs(node.appearance),
    filter: node.appearance?.dropShadow === true ? `url(#${DROP_SHADOW_ID})` : glow.filter,
  })
  if (node.appearance?.dropShadow === true) return withDefs(rect, DROP_SHADOW_DEFS)
  return glow.filter === undefined ? rect : withDefs(rect, glow.defs)
}
