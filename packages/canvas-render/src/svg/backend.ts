import { type LucideIconElement, VISUAL_ICONS } from '@kamiazya/whiteboard-plugin-visual'
import type {
  BoundingBox,
  CodeBlockNode,
  ListItemNode,
  Scene,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { ARROW_MARKER, edgeArrowEnds } from '../edge-arrows.js'
import { hopEndpoints, jumpsWithinSpan } from '../layout/edges/edge-flatten.js'
import { EDGE_JUMP_RADIUS_PX } from '../layout/edges/edge-jumps.js'
import { roundedEdgeCorners } from '../layout/edges/edge-rounding.js'
import type { ShapeTable } from '../layout/nodes/node-outline.js'
import { sceneBounds } from '../scene-bounds.js'
import { collectDefs } from './defs.js'
import type { SvgElements, TextEmphasisAttrs } from './elements.js'
import { formatCoord, sanitizeHref, trustedHref } from './format.js'
import {
  appearanceAttrs,
  idToken,
  isFiniteBox,
  isNonNegativeLength,
  isPositiveLength,
  PRESENTATION,
  pointsAttr,
  rectAttrs,
} from './paint.js'
import { serializeSvg } from './serialize.js'
import { glowOf, type ResolveTables, renderShape, renderSketchEdge } from './shapes.js'
import { applyOptimizationPasses } from './transform.js'
import { el, rawXml, type SvgChild, type SvgDef, withDefs } from './vnode.js'

/**
 * SVG `<text y>` is the BASELINE, not the top of the glyph box — `bbox.y`
 * is deliberately the line TOP (so sceneBounds/sceneDigest keep reading a
 * true top-left box), so the two must never be conflated. A non-finite
 * baseline is omitted rather than reaching `formatCoord` (which throws by
 * contract); an absent baseline reproduces the pre-baseline `y = bbox.y`
 * output byte-for-byte, which is what keeps `DETERMINISM_GOLDEN_SVG` frozen.
 */
function textBaselineY(run: TextRunNode): number {
  return run.baseline !== undefined && Number.isFinite(run.baseline)
    ? run.bbox.y + run.baseline
    : run.bbox.y
}

/** Breathing room the halo pill adds around the text box, in px. Paint-only
 * decoration in the arrowhead class: bounds keep reading the bbox, and the
 * 2px overhang never exceeds the hit tolerance. */
const TEXT_HALO_PAD_PX = 2

/** Corner radius of a text run's backdrop pill (GitHub's inline code). */
const BACKDROP_RADIUS_PX = 6

/** Inline emphasis the layout measured for — painted, or the flags are lies. */
function emphasisAttrs(run: TextRunNode): TextEmphasisAttrs {
  const attrs: TextEmphasisAttrs = {}
  if (run.strong === true) attrs['font-weight'] = '700'
  if (run.emphasis === true) attrs['font-style'] = 'italic'
  // A link is underlined rather than recolored because this backend is never
  // handed a palette: a run's fill is INHERITED from whatever host group the
  // SVG is dropped into, which is what lets one scene render on the editor's
  // light and dark surfaces and through resvg unchanged. Underline survives
  // all three, and color alone would not satisfy WCAG 1.4.1 anyway.
  const decorations = [
    ...(run.deleted === true ? ['line-through'] : []),
    ...(run.link ? ['underline'] : []),
  ]
  if (decorations.length > 0) attrs['text-decoration'] = decorations.join(' ')
  return attrs
}

/**
 * The id of the one shared truncation-fade mask. A document embedding several
 * of these SVGs ends up with the id repeated, which is harmless precisely
 * because every copy is byte-identical: `url(#…)` resolves to the first, and
 * the first says the same thing as the rest.
 */
const FADE_MASK_ID = 'wb-truncation-fade'

/**
 * `maskContentUnits="objectBoundingBox"` is what makes ONE mask enough: its
 * content is expressed in the 0..1 box of whatever element references it, so
 * it scales to each run rather than needing a definition per run. Verified
 * honoured by resvg (the PNG export path) as well as browsers — a fully black
 * mask renders byte-identically to an empty canvas there.
 *
 * Declared on each truncated run and hoisted by `collectDefs`, so the
 * document's `<defs>` appears exactly when something references the mask —
 * the presence-only rule as a mechanism instead of a bespoke scene walk.
 */
const FADE_DEFS: ReadonlyArray<SvgDef> = [
  {
    id: `${FADE_MASK_ID}-gradient`,
    node: el('linearGradient', { id: `${FADE_MASK_ID}-gradient`, x1: 0, y1: 0, x2: 1, y2: 0 }, [
      el('stop', { offset: 0.75, 'stop-color': '#ffffff' }),
      el('stop', { offset: 1, 'stop-color': '#000000' }),
    ]),
  },
  {
    id: FADE_MASK_ID,
    node: el('mask', { id: FADE_MASK_ID, maskContentUnits: 'objectBoundingBox' }, [
      el('rect', { x: 0, y: 0, width: 1, height: 1, fill: `url(#${FADE_MASK_ID}-gradient)` }),
    ]),
  },
]

/**
 * The tinted box behind a run (inline code today). Bleeds `backdropPadXPx`
 * past the run horizontally so the glyphs are not flush against the edge,
 * and stays inside the line box vertically so a backdrop can never overlap
 * the line above. A non-finite bbox renders as nothing rather than reaching
 * `formatCoord`, which throws by contract.
 */
function renderBackdrop(run: TextRunNode): SvgChild {
  if (run.backdrop === undefined || !isFiniteBox(run.bbox)) return []
  const pad = isNonNegativeLength(run.backdropPadXPx) ? run.backdropPadXPx : 0
  const box = {
    x: run.bbox.x - pad,
    y: run.bbox.y,
    w: run.bbox.w + 2 * pad,
    h: run.bbox.h,
  }
  return el('rect', {
    ...rectAttrs(box),
    rx: BACKDROP_RADIUS_PX,
    ...appearanceAttrs(run.backdrop),
  })
}

function renderTextRun(run: TextRunNode, tables?: ResolveTables): SvgChild {
  const halo = run.appearance?.halo
  const glow = glowOf(run.appearance, tables)
  // A surface-colored pill under the whole text box (a glyph-outline halo
  // leaves the crossed line peeking through word spaces), so a label
  // sitting ON an edge stays readable end to end.
  const underlay: SvgChild =
    halo !== undefined && halo.length > 0
      ? el('rect', {
          x: run.bbox.x - TEXT_HALO_PAD_PX,
          y: run.bbox.y - TEXT_HALO_PAD_PX,
          width: run.bbox.w + 2 * TEXT_HALO_PAD_PX,
          height: run.bbox.h + 2 * TEXT_HALO_PAD_PX,
          rx: TEXT_HALO_PAD_PX,
          fill: halo,
        })
      : []
  const textEl = el(
    'text',
    {
      x: run.bbox.x,
      y: textBaselineY(run),
      ...appearanceAttrs(run.appearance),
      ...emphasisAttrs(run),
      filter: glow.filter,
      mask: run.truncated === true ? `url(#${FADE_MASK_ID})` : undefined,
      // A code run's whitespace is CONTENT: XML collapses it otherwise, and a
      // fenced line loses the indentation that says what nests inside what.
      'xml:space': run.code === true ? 'preserve' : undefined,
    },
    [run.text],
  )
  const text = withDefs(textEl, [...(run.truncated === true ? FADE_DEFS : []), ...glow.defs])
  // The backdrop is painted before the halo underlay so a run can carry both
  // without the panel hiding the halo; inline code uses this for its tinted
  // pill.
  const content: SvgChild = [renderBackdrop(run), underlay, text]
  if (!run.link) return content
  const href =
    run.link.kind === 'link' ? sanitizeHref(run.link.href) : trustedHref(run.link.documentId)
  return el('a', { href }, [content])
}

function renderListItem(item: ListItemNode, tables?: ResolveTables): SvgChild {
  const tx = item.bbox.x
  return el(
    'g',
    tx !== 0 ? { transform: `translate(${formatCoord(tx)},0)` } : undefined,
    item.children.map((child) => renderNode(child, tables)),
  )
}

function renderTableCell(cell: TableCellSceneNode, tables?: ResolveTables): SvgChild {
  const tx = cell.bbox.x
  return el(
    'g',
    tx !== 0 ? { transform: `translate(${formatCoord(tx)},0)` } : undefined,
    cell.runs.map((run) => renderTextRun(run, tables)),
  )
}

function renderTableRow(row: TableRowSceneNode, tables?: ResolveTables): SvgChild {
  // A hairline on the row's bottom edge is the whole of a table's chrome —
  // no cell grid, no zebra wash. Drawn at the row's own y so it separates
  // this row from the next rather than boxing either.
  const separator: SvgChild =
    row.appearance !== undefined && isFiniteBox(row.bbox)
      ? el('rect', {
          ...rectAttrs({ x: row.bbox.x, y: row.bbox.y + row.bbox.h - 1, w: row.bbox.w, h: 1 }),
          ...appearanceAttrs(row.appearance),
          role: PRESENTATION,
        })
      : []
  return el('g', undefined, [separator, row.cells.map((cell) => renderTableCell(cell, tables))])
}

/**
 * A fenced block: its tinted panel, then one `<text>` per source line.
 *
 * The per-line form is not styling. SVG `<text>` collapses a newline to a
 * space, so the single-element reading painted an entire fence on one line
 * inside a box sized for all of them — the code ran off the right edge and
 * left the rest of the box blank. `runs` is absent only for a scene built
 * before layout carried them, which still renders through the old path
 * rather than nothing.
 */
function renderCodeBlock(node: CodeBlockNode, tables?: ResolveTables): SvgChild {
  const panel: SvgChild =
    node.appearance !== undefined && isFiniteBox(node.bbox)
      ? el('rect', {
          ...rectAttrs(node.bbox),
          rx: isPositiveLength(node.radius) ? node.radius : undefined,
          ...appearanceAttrs(node.appearance),
          role: PRESENTATION,
        })
      : []
  if (node.runs === undefined) {
    return [panel, el('text', { ...rectAttrs(node.bbox), 'xml:space': 'preserve' }, [node.value])]
  }
  return [panel, node.runs.map((run) => renderTextRun(run, tables))]
}

type EdgePoint = { readonly x: number; readonly y: number }

type EdgeJump = { readonly segment: number; readonly x: number; readonly y: number }

/**
 * Path commands for one straight run from `from` to `to`, hopping over each
 * jump point with a half-circle arc. Sweep 1 bulges to the LEFT of travel
 * in SVG's y-down coordinates (up, for a rightward run) — drawio-style
 * "over", and the side `flattenDrawnEdgePath` samples for hit-testing and
 * the selection highlight. Jumps arrive ordered along the run.
 */
function lineWithJumps(
  from: EdgePoint,
  to: EdgePoint,
  jumps: readonly EdgeJump[],
): readonly string[] {
  const parts: string[] = []
  for (const jump of jumps) {
    const hop = hopEndpoints(from, to, jump)
    if (hop === undefined) continue
    parts.push(`L ${formatCoord(hop.entry.x)} ${formatCoord(hop.entry.y)}`)
    parts.push(
      `A ${EDGE_JUMP_RADIUS_PX} ${EDGE_JUMP_RADIUS_PX} 0 0 1 ${formatCoord(hop.exit.x)} ${formatCoord(hop.exit.y)}`,
    )
  }
  parts.push(`L ${formatCoord(to.x)} ${formatCoord(to.y)}`)
  return parts
}

/** The polyline as a path `d`, hopping over each jump on its segment. */
function jumpedPathData(path: readonly EdgePoint[], jumps: readonly EdgeJump[]): string {
  const first = path[0]
  if (first === undefined) return ''
  const parts = [`M ${formatCoord(first.x)} ${formatCoord(first.y)}`]
  for (let seg = 0; seg < path.length - 1; seg += 1) {
    parts.push(
      ...lineWithJumps(
        path[seg] as EdgePoint,
        path[seg + 1] as EdgePoint,
        jumps.filter((jump) => jump.segment === seg),
      ),
    )
  }
  return parts.join(' ')
}

/**
 * The same polyline with its corners rounded off, per the shared
 * `roundedEdgeCorners` decomposition (see layout/edges/edge-rounding.ts — the
 * editor's hit-testing flattens the SAME corners, which is what keeps a tap
 * landing on the ink). Degenerate inputs fall back to the straight reading
 * rather than emitting a malformed `d`, matching this package's never-throw
 * rule.
 */
function roundedPathData(path: readonly EdgePoint[], jumps: readonly EdgeJump[] = []): string {
  const first = path[0]
  const last = path.at(-1)
  if (first === undefined || last === undefined) return ''
  if (path.length < 3) {
    return [
      `M ${formatCoord(first.x)} ${formatCoord(first.y)}`,
      ...lineWithJumps(first, last, jumpsWithinSpan(jumps, 0, first, last)),
    ].join(' ')
  }

  const parts = [`M ${formatCoord(first.x)} ${formatCoord(first.y)}`]
  let current = first
  const corners = roundedEdgeCorners(path)
  for (const [index, { enter, control, leave }] of corners.entries()) {
    parts.push(...lineWithJumps(current, enter, jumpsWithinSpan(jumps, index, current, enter)))
    parts.push(
      `Q ${formatCoord(control.x)} ${formatCoord(control.y)} ${formatCoord(leave.x)} ${formatCoord(leave.y)}`,
    )
    current = leave
  }
  parts.push(...lineWithJumps(current, last, jumpsWithinSpan(jumps, corners.length, current, last)))
  return parts.join(' ')
}

function arrowMarkerDef(direction: 'start' | 'end', fill: string): SvgDef {
  const geometry = ARROW_MARKER[direction]
  const id = `wb-arrow-${direction}-${idToken(fill)}`
  return {
    id,
    node: el(
      'marker',
      {
        id,
        markerWidth: ARROW_MARKER.width,
        markerHeight: ARROW_MARKER.height,
        refX: geometry.refX,
        refY: geometry.refY,
        markerUnits: 'userSpaceOnUse',
        orient: 'auto',
      },
      [el('polygon', { points: pointsAttr(geometry.points), fill })],
    ),
  }
}

function renderIconElement(element: LucideIconElement): SvgChild {
  switch (element.tag) {
    case 'path':
      return el('path', { d: element.d })
    case 'rect':
      return el('rect', {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rx: element.rx,
      })
    case 'circle':
      return el('circle', { cx: element.cx, cy: element.cy, r: element.r })
    case 'ellipse':
      return el('ellipse', { cx: element.cx, cy: element.cy, rx: element.rx, ry: element.ry })
  }
}

/** Baseline drop below the bbox center, as a fraction of the glyph size —
 * roughly half a typical glyph cap height, so the badge reads centered. */
const GLYPH_BASELINE_FACTOR = 0.35

/**
 * Caller-supplied icon geometry, merged over the vendored table (caller
 * wins on a shared name). Plain data — a record of primitive elements in
 * the 24x24 lucide viewBox — so a composition root can feed any icon set
 * (a full lucide dependency, a facet distribution's own glyphs) without
 * this package depending on one, and the table survives `postMessage`.
 */
/**
 * An icon set's paint, applied to the whole `<symbol>` definition so one def
 * serves every referencing node. Only the stroke COLOR is left to inherit
 * from each `<use>`.
 */
export type IconPaint = Readonly<Record<string, string | number>>

/**
 * One icon: its geometry plus the two things geometry is meaningless without.
 *
 * `viewBox` is the coordinate space the geometry is drawn in, and `paint` the
 * convention it is authored for. Both were hard-coded to the bundled set's
 * before this, so a contributed icon in any other space came out the wrong
 * size and clipped, and one wanting a fill came out invisible.
 */
export interface IconContribution {
  readonly geometry: ReadonlyArray<LucideIconElement>
  readonly viewBox?: string
  readonly paint?: IconPaint
}

export type IconTable = Readonly<Record<string, IconContribution>>

/**
 * What a set that declares neither gets. 24x24 stroke-only is what every icon
 * in this repo is authored for, so a table saying nothing still draws.
 */
const FALLBACK_ICON_VIEWBOX = '0 0 24 24'
const FALLBACK_ICON_PAINT: IconPaint = {
  fill: 'none',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
}

/**
 * `Array.isArray` and not a bare `!== undefined`: both tables are plain
 * objects, so a prototype-inherited name (`toString`) answers a function,
 * which must degrade like any unknown name rather than throw downstream.
 */
function lookupIcon(name: string, icons: IconTable | undefined): IconContribution | undefined {
  const fromCaller = icons === undefined ? undefined : icons[name]
  const found = fromCaller ?? VISUAL_ICONS[name]
  return Array.isArray(found?.geometry) ? found : undefined
}

function renderNode(node: SceneNode, tables?: ResolveTables): SvgChild {
  switch (node.kind) {
    case 'textRun':
      return renderTextRun(node, tables)
    case 'heading':
      return el(
        'g',
        undefined,
        node.runs.map((run) => renderTextRun(run, tables)),
      )
    case 'paragraph':
      return el(
        'g',
        undefined,
        node.runs.map((run) => renderTextRun(run, tables)),
      )
    case 'list':
      return el(
        'g',
        undefined,
        node.items.map((item) => renderListItem(item, tables)),
      )
    case 'codeBlock':
      return renderCodeBlock(node, tables)
    case 'blockquote':
      // `fill-opacity` on the group is INHERITED by every descendant text
      // run — which is how quoted prose reads muted without naming a text
      // colour that would be wrong in one of the two host themes. The bar
      // child sets its own value, and a descendant's own presentation
      // attribute wins over the inherited one (it does not multiply).
      return el(
        'g',
        { ...appearanceAttrs(node.appearance), role: PRESENTATION },
        node.children.map((child) => renderNode(child, tables)),
      )
    case 'group':
      return el(
        'g',
        { role: PRESENTATION },
        node.children.map((child) => renderNode(child, tables)),
      )
    case 'thematicBreak':
      return el('rect', {
        ...rectAttrs(node.bbox),
        ...appearanceAttrs(node.appearance),
        role: PRESENTATION,
      })
    case 'table':
      return el(
        'g',
        undefined,
        node.rows.map((row) => renderTableRow(row, tables)),
      )
    case 'rawHtml':
      // Raw HTML has no independently-verifiable well-formedness guarantee
      // (it is caller-supplied Markdown-embedded HTML), so it is escaped as
      // text rather than injected verbatim like a trusted SVG fragment.
      return el('text', rectAttrs(node.bbox), [node.value])
    case 'unresolvedReference':
      return el('g', { role: PRESENTATION })
    case 'svgFragment': {
      // Precondition: the caller has already validated `svg` is well-formed
      // XML before constructing this node — emitted verbatim, not escaped.
      // A nested <svg> carries the position: the fragment's own coordinates
      // stay untouched, the wrapper's x/y move them into document flow, and
      // this deliberately does NOT use a transform so the listItem/tableCell
      // x-transform-boundary set (translate-scene.ts) stays exactly two —
      // a fragment has no scene-graph children for that machinery to see.
      // overflow stays visible so a fragment taller than its reported size
      // renders rather than silently clipping. A non-finite bbox degrades
      // to the unpositioned group form (total rule, mirroring shape).
      const { x, y, w, h } = node.bbox
      const positioned =
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)
      const role = node.role === 'presentation' ? PRESENTATION : undefined
      if (!positioned) {
        return el('g', role === undefined ? undefined : { role }, [rawXml(node.svg)])
      }
      return el('svg', { x, y, width: w, height: h, overflow: 'visible', role }, [rawXml(node.svg)])
    }
    case 'embedPlaceholder':
      // SVG <text> y is the BASELINE, so the box TOP would paint the title
      // one line above the placeholder's own space, colliding with the
      // preceding block. The node carries no measured ascent (it is not a
      // text run), so the baseline is derived from the box: 0.8 matches the
      // ascent ratio the measurer contract documents for body text.
      return el('a', { href: trustedHref(`#${node.documentId}`) }, [
        el('text', { x: node.bbox.x, y: node.bbox.y + node.bbox.h * 0.8 }, [node.title]),
      ])
    case 'embedResolved':
      return el(
        'g',
        undefined,
        node.children.map((child) => renderNode(child, tables)),
      )
    case 'edge': {
      if (node.ink?.style === 'sketch') return renderSketchEdge(node, node.ink, tables)
      const appearance = appearanceAttrs(node.appearance)
      // `fill="none"` is not decoration. SVG's initial fill is black and a
      // <polyline> fills the region its points enclose, so a bent edge would
      // paint a solid wedge across its own corner in whatever fill the
      // surrounding document inherits — invisible while every path had two
      // points, glaring the moment routing started bending them. A <path>
      // needs it for exactly the same reason. It is declared before the
      // appearance spread, matching the string backend's emission order (an
      // edge appearance never carries a fill of its own).
      const jumps = node.jumps ?? []
      // Arrowheads are shared <marker> definitions in the edge's stroke
      // color, referenced per end — one definition per (direction, color)
      // instead of a polygon per edge end. Marker geometry derives from the
      // same constants as `edgeArrowPolygons` (edge-arrows.ts), which
      // sceneBounds keeps reading for the wings' reach; the arrowhead pixel
      // goldens pin that the two stay the same ink. Which ends get one is
      // `edgeArrowEnds` — the polygon renderer's own skip rule — because a
      // marker on a direction-less end would paint at angle 0 where the
      // polygon drew nothing.
      const stroke = node.appearance?.stroke
      // No stroke means the polyline itself is invisible (SVG's default
      // stroke is none) — the arrow must match it, not fall back to the
      // marker content's default black fill and float detached.
      const arrowFill = typeof stroke === 'string' && stroke.length > 0 ? stroke : 'none'
      const ends = edgeArrowEnds(node)
      const startDef = ends.from ? arrowMarkerDef('start', arrowFill) : undefined
      const endDef = ends.to ? arrowMarkerDef('end', arrowFill) : undefined
      const markers = {
        'marker-start': startDef === undefined ? undefined : `url(#${startDef.id})`,
        'marker-end': endDef === undefined ? undefined : `url(#${endDef.id})`,
      }
      const polyline =
        node.rounded === true
          ? el('path', {
              d: roundedPathData(node.path, jumps),
              fill: 'none',
              ...appearance,
              ...markers,
              role: PRESENTATION,
            })
          : jumps.length > 0
            ? el('path', {
                d: jumpedPathData(node.path, jumps),
                fill: 'none',
                ...appearance,
                ...markers,
                role: PRESENTATION,
              })
            : el('polyline', {
                points: pointsAttr(node.path),
                fill: 'none',
                ...appearance,
                ...markers,
                role: PRESENTATION,
              })
      const glow = glowOf(node.appearance, tables)
      const defs = [
        ...(startDef === undefined ? [] : [startDef]),
        ...(endDef === undefined ? [] : [endDef]),
        ...glow.defs,
      ]
      const line =
        glow.filter === undefined
          ? polyline
          : { ...polyline, attrs: { ...polyline.attrs, filter: glow.filter } }
      return defs.length > 0 ? withDefs(line, defs) : line
    }
    case 'shape':
      return renderShape(node, tables)
    case 'icon': {
      if (!isFiniteBox(node.bbox)) return []
      const contribution = lookupIcon(node.icon, tables?.icons)
      if (contribution === undefined) return []
      const id = `wb-icon-${idToken(node.icon)}`
      const def: SvgDef = {
        id,
        node: el('symbol', { id, viewBox: contribution.viewBox ?? FALLBACK_ICON_VIEWBOX }, [
          // The set's paint lives ON the definition; only the stroke COLOR
          // inherits from each referencing <use>, so one def serves every
          // color-assigned node.
          el(
            'g',
            contribution.paint ?? FALLBACK_ICON_PAINT,
            contribution.geometry.map(renderIconElement),
          ),
        ]),
      }
      const paint = appearanceAttrs(node.appearance)
      const glow = glowOf(node.appearance, tables)
      const use = el('use', {
        href: `#${id}`,
        x: node.bbox.x,
        y: node.bbox.y,
        width: node.bbox.w,
        height: node.bbox.h,
        stroke: paint.stroke,
        'stroke-opacity': paint['stroke-opacity'],
        filter: glow.filter,
      })
      return withDefs(use, [def, ...glow.defs])
    }
    case 'glyph': {
      if (!isFiniteBox(node.bbox) || node.glyph.length === 0) return []
      // A single glyph sized to the smaller bbox side and centered via
      // text-anchor plus a fixed baseline offset. The offset approximates
      // vertical centering without dominant-baseline, whose resolution
      // differs across renderers (browsers vs resvg) and would break the
      // pixel-agreement this backend otherwise keeps.
      const size = Math.min(node.bbox.w, node.bbox.h)
      return el(
        'text',
        {
          x: node.bbox.x + node.bbox.w / 2,
          y: node.bbox.y + node.bbox.h / 2 + size * GLYPH_BASELINE_FACTOR,
          'font-size': size,
          'text-anchor': 'middle',
        },
        [node.glyph],
      )
    }
    case 'image': {
      // Fixed attribute order (x y width height href preserveAspectRatio)
      // per this package's canonical-serialization rule. Aspect is always
      // preserved; alt renders as a <title> child (the SVG accessible-name
      // mechanism), absence marks the image as presentation.
      const hasAlt = node.alt !== undefined && node.alt.length > 0
      return el(
        'image',
        {
          ...rectAttrs(node.bbox),
          href: node.href,
          preserveAspectRatio: `xMidYMid ${node.fit === 'cover' ? 'slice' : 'meet'}`,
          role: hasAlt ? undefined : PRESENTATION,
        },
        hasAlt ? [el('title', undefined, [node.alt as string])] : [],
      )
    }
  }
}

/**
 * Document-envelope options for `renderSceneToSvg`. Plain TS type: the
 * scene graph and its render options never cross a process boundary, so
 * per this package's zod-schema-discipline exemption they carry no Zod
 * schema (`sceneDigestSchema` remains the package's only Zod surface).
 *
 * Activation rule: if `options` is omitted, or present but with none of
 * these fields set, output is byte-identical to the legacy no-envelope
 * form. Setting any field activates the full envelope (derived `viewBox`
 * plus `width`/`height`) rather than a partial one, so there is exactly
 * one enveloped shape.
 */
export interface SvgDocumentOptions {
  readonly width?: number
  readonly height?: number
  readonly viewBox?: BoundingBox
  readonly padding?: number
  readonly background?: string
  /** Inheritable default text color, emitted as `fill` on the root `<svg>`.
   *  Markdown body runs carry no fill of their own (inside the editor they
   *  inherit the host element's CSS `fill`), so a scene rendered standalone
   *  on a non-white background needs this to be self-describing. Elements
   *  that carry their own fill are unaffected (nearest-ancestor wins). An
   *  empty or non-string value is omitted, never defaulted. */
  readonly textFill?: string
  /** Extra icon geometry for `IconSceneNode` resolution, merged over the
   *  vendored set (see `IconTable`). A resolution input, not document
   *  chrome — it does NOT activate the envelope. */
  readonly icons?: IconTable
  /** Silhouettes by namespaced id, merged over the built-in table. The same
   *  table layout was handed: layout uses it for the content box and edge
   *  anchoring, this backend to draw. A resolution input, not document
   *  chrome — it does NOT activate the envelope. */
  readonly shapes?: ShapeTable
}

function hasEnvelopeOptions(
  options: SvgDocumentOptions | undefined,
): options is SvgDocumentOptions {
  if (!options) return false
  return (
    options.width !== undefined ||
    options.height !== undefined ||
    options.viewBox !== undefined ||
    options.padding !== undefined ||
    options.background !== undefined ||
    (typeof options.textFill === 'string' && options.textFill.length > 0)
  )
}

/**
 * A negative width/height is invalid on both the root `<svg>` element and
 * `viewBox` (SVG spec) — `x`/`y` may be negative (an offset), but `w`/`h`
 * must not be, so this is checked on top of plain finiteness.
 */
function isUsableViewBox(box: BoundingBox): boolean {
  return isFiniteBox(box) && box.w >= 0 && box.h >= 0
}

/** Non-finite or negative padding is not a valid expansion amount — treated as 0 so the function stays total. */
function sanitizePadding(padding: number | undefined): number {
  if (padding === undefined || !Number.isFinite(padding) || padding < 0) return 0
  return padding
}

function expandBox(box: BoundingBox, padding: number): BoundingBox {
  if (padding === 0) return box
  return { x: box.x - padding, y: box.y - padding, w: box.w + padding * 2, h: box.h + padding * 2 }
}

function resolveViewBox(scene: Scene, options: SvgDocumentOptions): BoundingBox {
  if (options.viewBox && isUsableViewBox(options.viewBox)) return options.viewBox
  return expandBox(sceneBounds(scene), sanitizePadding(options.padding))
}

/** A negative root-element width/height is invalid SVG — falls back to the derived dimension, same as a non-finite value. */
function resolveDimension(explicit: number | undefined, fallback: number): number {
  return explicit !== undefined && Number.isFinite(explicit) && explicit >= 0 ? explicit : fallback
}

function renderBackgroundRect(box: BoundingBox, background: string): SvgChild {
  return el('rect', { ...rectAttrs(box), fill: background, role: PRESENTATION })
}

const SVG_XMLNS = 'http://www.w3.org/2000/svg'

/**
 * Serializes a decorated scene to an SVG string. Pure, no DOM — the same
 * implementation runs on Node, in the browser, and on Workers. Output
 * follows the canonical serialization rules (fixed attribute order,
 * consistent escaping, single root `xmlns`, one number formatter) so the
 * same scene produces byte-identical SVG everywhere.
 *
 * With no `options` (or an options object with no fields set), the root
 * element carries only `xmlns` — the exact string this function has always
 * produced. Passing any `SvgDocumentOptions` field activates the document
 * envelope: fixed root-attribute order `xmlns width height viewBox fill`
 * (`fill` only when `textFill` is set), plus a
 * leading `role="presentation"` background rect (document chrome, not a
 * per-node visual attribute — the one exemption to this package's
 * no-visual-attributes rule) when `background` is set.
 */
/**
 * The document's assembled pieces, shared by `renderSceneToSvg` and the
 * keyed renderer (svg/keyed.ts) so the two can never disagree on root
 * attributes, defs, background, or per-entry bodies. `body` holds exactly
 * one (possibly empty) child per top-level scene entry, hoisted, in
 * document order — the unit the keyed renderer wraps and the scene-diff
 * scoreboard counts.
 */
export interface SvgDocumentParts {
  /** Fixed order: xmlns [width height viewBox fill] — the envelope rule. */
  readonly rootAttrs: SvgElements['svg']
  readonly defs: SvgChild
  readonly background: SvgChild
  readonly body: ReadonlyArray<SvgChild>
}

export function buildSvgDocumentParts(
  scene: Scene,
  options?: SvgDocumentOptions,
): SvgDocumentParts {
  // Optimization passes run before defs collection only by convention —
  // they preserve `defs` declarations on rebuilt nodes, so the order is not
  // load-bearing. Applied per top-level node: passes are group-local by
  // construction (see transform.ts).
  let region: BoundingBox | undefined
  const tables: ResolveTables = {
    icons: options?.icons,
    shapes: options?.shapes,
    glowRegion: () => {
      region ??= sceneBounds(scene)
      return region
    },
  }
  const body = scene.nodes
    .map((node) => renderNode(node, tables))
    .map((node) => applyOptimizationPasses(node))
  // Presence-only, exactly like an absent appearance attribute: a scene
  // declaring no definitions emits the same bytes it always has.
  const collected = collectDefs(body)
  const defs: SvgChild =
    collected.length > 0
      ? el(
          'defs',
          undefined,
          collected.map((def) => def.node),
        )
      : []

  if (!hasEnvelopeOptions(options)) {
    return { rootAttrs: { xmlns: SVG_XMLNS }, defs, background: [], body }
  }

  const viewBox = resolveViewBox(scene, options)
  const width = resolveDimension(options.width, viewBox.w)
  const height = resolveDimension(options.height, viewBox.h)
  const viewBoxAttr = `${formatCoord(viewBox.x)} ${formatCoord(viewBox.y)} ${formatCoord(viewBox.w)} ${formatCoord(viewBox.h)}`
  const background: SvgChild =
    options.background !== undefined ? renderBackgroundRect(viewBox, options.background) : []

  return {
    // Fixed root-attribute order: xmlns width height viewBox fill.
    rootAttrs: {
      xmlns: SVG_XMLNS,
      width,
      height,
      viewBox: viewBoxAttr,
      fill:
        typeof options.textFill === 'string' && options.textFill.length > 0
          ? options.textFill
          : undefined,
    },
    defs,
    background,
    body,
  }
}

export function renderSceneToSvg(scene: Scene, options?: SvgDocumentOptions): string {
  const parts = buildSvgDocumentParts(scene, options)
  return serializeSvg(el('svg', parts.rootAttrs, [parts.defs, parts.background, parts.body]))
}
