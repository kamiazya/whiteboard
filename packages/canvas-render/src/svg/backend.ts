import { edgeArrowPolygons } from '../edge-arrows.js'
import { hopEndpoints, jumpsWithinSpan } from '../layout/edge-flatten.js'
import { EDGE_JUMP_RADIUS_PX } from '../layout/edge-jumps.js'
import { roundedEdgeCorners } from '../layout/edge-rounding.js'
import { sceneBounds } from '../scene-bounds.js'
import type {
  Appearance,
  BoundingBox,
  ListItemNode,
  Scene,
  SceneNode,
  ShapeSceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
} from '../scene-graph.js'
import { escapeXmlAttr, escapeXmlText, formatCoord, sanitizeHref } from './format.js'

/**
 * Decorative/presentational elements (backgrounds, dividers, group
 * wrappers) that carry no independently-meaningful semantics get
 * `role="presentation"` so a screen reader does not announce them; text
 * runs and links keep their natural implicit role.
 */
const PRESENTATION_ATTR = 'role="presentation"'

function rectAttrs(bbox: BoundingBox): string {
  // Fixed declaration order: x, y, width, height.
  return `x="${formatCoord(bbox.x)}" y="${formatCoord(bbox.y)}" width="${formatCoord(bbox.w)}" height="${formatCoord(bbox.h)}"`
}

function isFiniteBox(box: BoundingBox): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite)
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Non-finite or negative is dropped; zero is a legitimate stroke-width/font-size. */
function isNonNegativeLength(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** SVG treats a negative `rx` as an error and `rx="0"` is noise, so both are omitted. */
function isPositiveLength(value: number | undefined): value is number {
  return isNonNegativeLength(value) && value > 0
}

function withLeadingSpace(attrs: string): string {
  return attrs === '' ? '' : ` ${attrs}`
}

/**
 * Presence-only presentation attributes for a shape/text-run/edge, in the
 * fixed order `fill stroke stroke-width font-family font-size`. An absent
 * or unusable field is omitted rather than defaulted — see the
 * `Appearance` doc comment for why the backend never invents a value.
 */
function appearanceAttrs(appearance?: Appearance): string {
  if (!appearance) return ''
  const parts: string[] = []
  if (isNonEmptyString(appearance.fill)) parts.push(`fill="${escapeXmlAttr(appearance.fill)}"`)
  if (isNonEmptyString(appearance.stroke)) {
    parts.push(`stroke="${escapeXmlAttr(appearance.stroke)}"`)
  }
  if (isNonNegativeLength(appearance.strokeWidth)) {
    parts.push(`stroke-width="${formatCoord(appearance.strokeWidth)}"`)
  }
  if (isNonEmptyString(appearance.fontFamily)) {
    parts.push(`font-family="${escapeXmlAttr(appearance.fontFamily)}"`)
  }
  if (isNonNegativeLength(appearance.fontSize)) {
    parts.push(`font-size="${formatCoord(appearance.fontSize)}"`)
  }
  return parts.join(' ')
}

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

function renderTextRun(run: TextRunNode): string {
  const appearance = withLeadingSpace(appearanceAttrs(run.appearance))
  const position = `x="${formatCoord(run.bbox.x)}" y="${formatCoord(textBaselineY(run))}"`
  const body = escapeXmlText(run.text)
  const halo = run.appearance?.halo
  // A surface-colored pill under the whole text box (a glyph-outline halo
  // leaves the crossed line peeking through word spaces), so a label
  // sitting ON an edge stays readable end to end.
  const underlay =
    halo !== undefined && halo.length > 0
      ? `<rect x="${formatCoord(run.bbox.x - TEXT_HALO_PAD_PX)}" y="${formatCoord(run.bbox.y - TEXT_HALO_PAD_PX)}" width="${formatCoord(run.bbox.w + 2 * TEXT_HALO_PAD_PX)}" height="${formatCoord(run.bbox.h + 2 * TEXT_HALO_PAD_PX)}" rx="${formatCoord(TEXT_HALO_PAD_PX)}" fill="${escapeXmlAttr(halo)}"/>`
      : ''
  const text = `${underlay}<text ${position}${appearance}>${body}</text>`
  if (!run.link) return text
  const href = run.link.kind === 'link' ? sanitizeHref(run.link.href) : run.link.canvasId
  return `<a href="${escapeXmlAttr(href)}">${text}</a>`
}

/**
 * The box chrome of a spatial canvas node. A non-finite bbox field is a
 * layout bug this package must not crash on — it renders as the empty
 * string rather than reaching `formatCoord`, which throws by contract.
 */
function renderShape(node: ShapeSceneNode): string {
  if (!isFiniteBox(node.bbox)) return ''
  const rx = isPositiveLength(node.radius) ? ` rx="${formatCoord(node.radius)}"` : ''
  const appearance = withLeadingSpace(appearanceAttrs(node.appearance))
  return `<rect ${rectAttrs(node.bbox)}${rx}${appearance}/>`
}

function renderListItem(item: ListItemNode): string {
  const tx = item.bbox.x
  const transform = tx !== 0 ? ` transform="translate(${formatCoord(tx)},0)"` : ''
  return `<g${transform}>${item.children.map(renderNode).join('')}</g>`
}

function renderTableCell(cell: TableCellSceneNode): string {
  const tx = cell.bbox.x
  const transform = tx !== 0 ? ` transform="translate(${formatCoord(tx)},0)"` : ''
  return `<g${transform}>${cell.runs.map(renderTextRun).join('')}</g>`
}

function renderTableRow(row: TableRowSceneNode): string {
  return `<g>${row.cells.map(renderTableCell).join('')}</g>`
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
 * `roundedEdgeCorners` decomposition (see layout/edge-rounding.ts — the
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

function renderNode(node: SceneNode): string {
  switch (node.kind) {
    case 'textRun':
      return renderTextRun(node)
    case 'heading':
    case 'paragraph':
      return `<g>${node.runs.map(renderTextRun).join('')}</g>`
    case 'list':
      return `<g>${node.items.map(renderListItem).join('')}</g>`
    case 'codeBlock':
      return `<text ${rectAttrs(node.bbox)} xml:space="preserve">${escapeXmlText(node.value)}</text>`
    case 'blockquote':
    case 'group':
      return `<g ${PRESENTATION_ATTR}>${node.children.map(renderNode).join('')}</g>`
    case 'thematicBreak':
      return `<rect ${rectAttrs(node.bbox)} ${PRESENTATION_ATTR}/>`
    case 'table':
      return `<g>${node.rows.map(renderTableRow).join('')}</g>`
    case 'rawHtml':
      // Raw HTML has no independently-verifiable well-formedness guarantee
      // (it is caller-supplied Markdown-embedded HTML), so it is escaped as
      // text rather than injected verbatim like a trusted SVG fragment.
      return `<text ${rectAttrs(node.bbox)}>${escapeXmlText(node.value)}</text>`
    case 'unresolvedReference':
      return `<g ${PRESENTATION_ATTR}/>`
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
      if (!positioned) {
        return node.role === 'presentation'
          ? `<g ${PRESENTATION_ATTR}>${node.svg}</g>`
          : `<g>${node.svg}</g>`
      }
      const attrs = `x="${formatCoord(x)}" y="${formatCoord(y)}" width="${formatCoord(w)}" height="${formatCoord(h)}" overflow="visible"`
      return node.role === 'presentation'
        ? `<svg ${attrs} ${PRESENTATION_ATTR}>${node.svg}</svg>`
        : `<svg ${attrs}>${node.svg}</svg>`
    }
    case 'embedPlaceholder':
      // SVG <text> y is the BASELINE, so the box TOP would paint the title
      // one line above the placeholder's own space, colliding with the
      // preceding block. The node carries no measured ascent (it is not a
      // text run), so the baseline is derived from the box: 0.8 matches the
      // ascent ratio the measurer contract documents for body text.
      return `<a href="#${escapeXmlAttr(node.canvasId)}"><text x="${formatCoord(node.bbox.x)}" y="${formatCoord(node.bbox.y + node.bbox.h * 0.8)}">${escapeXmlText(node.title)}</text></a>`
    case 'embedResolved':
      return `<g>${node.children.map(renderNode).join('')}</g>`
    case 'edge': {
      const points = node.path.map((p) => `${formatCoord(p.x)},${formatCoord(p.y)}`).join(' ')
      const appearance = withLeadingSpace(appearanceAttrs(node.appearance))
      // `fill="none"` is not decoration. SVG's initial fill is black and a
      // <polyline> fills the region its points enclose, so a bent edge would
      // paint a solid wedge across its own corner in whatever fill the
      // surrounding document inherits — invisible while every path had two
      // points, glaring the moment routing started bending them. A <path>
      // needs it for exactly the same reason.
      const jumps = node.jumps ?? []
      const polyline =
        node.rounded === true
          ? `<path d="${roundedPathData(node.path, jumps)}" fill="none"${appearance} ${PRESENTATION_ATTR}/>`
          : jumps.length > 0
            ? `<path d="${jumpedPathData(node.path, jumps)}" fill="none"${appearance} ${PRESENTATION_ATTR}/>`
            : `<polyline points="${points}" fill="none"${appearance} ${PRESENTATION_ATTR}/>`
      // Arrowheads are filled triangles in the edge's stroke color, drawn
      // after (over) the polyline. Geometry comes from the shared helper so
      // sceneBounds always agrees on how far the wings reach.
      const stroke = node.appearance?.stroke
      // No stroke means the polyline itself is invisible (SVG's default
      // stroke is none) — the arrow must match it, not fall back to the
      // polygon's default black fill and float detached.
      const arrowFill =
        typeof stroke === 'string' && stroke.length > 0
          ? ` fill="${escapeXmlAttr(stroke)}"`
          : ' fill="none"'
      const arrows = edgeArrowPolygons(node)
        .map((arrow) => {
          const arrowPoints = arrow.points
            .map((p) => `${formatCoord(p.x)},${formatCoord(p.y)}`)
            .join(' ')
          return `<polygon points="${arrowPoints}"${arrowFill} ${PRESENTATION_ATTR}/>`
        })
        .join('')
      return `${polyline}${arrows}`
    }
    case 'shape':
      return renderShape(node)
    case 'image': {
      // Fixed attribute order (x y width height href preserveAspectRatio)
      // per this package's canonical-serialization rule. Aspect is always
      // preserved; alt renders as a <title> child (the SVG accessible-name
      // mechanism), absence marks the image as presentation.
      const title =
        node.alt !== undefined && node.alt.length > 0
          ? `<title>${escapeXmlText(node.alt)}</title>`
          : ''
      const roleAttr = title === '' ? ` ${PRESENTATION_ATTR}` : ''
      return `<image ${rectAttrs(node.bbox)} href="${escapeXmlAttr(node.href)}" preserveAspectRatio="xMidYMid ${node.fit === 'cover' ? 'slice' : 'meet'}"${roleAttr}>${title}</image>`
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

function renderBackgroundRect(box: BoundingBox, background: string): string {
  return `<rect ${rectAttrs(box)} fill="${escapeXmlAttr(background)}" ${PRESENTATION_ATTR}/>`
}

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
export function renderSceneToSvg(scene: Scene, options?: SvgDocumentOptions): string {
  const body = scene.nodes.map(renderNode).join('')

  if (!hasEnvelopeOptions(options)) {
    return `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  }

  const viewBox = resolveViewBox(scene, options)
  const width = resolveDimension(options.width, viewBox.w)
  const height = resolveDimension(options.height, viewBox.h)
  const viewBoxAttr = `${formatCoord(viewBox.x)} ${formatCoord(viewBox.y)} ${formatCoord(viewBox.w)} ${formatCoord(viewBox.h)}`
  const background =
    options.background !== undefined ? renderBackgroundRect(viewBox, options.background) : ''
  // Fixed root-attribute order: xmlns width height viewBox fill.
  const textFillAttr =
    typeof options.textFill === 'string' && options.textFill.length > 0
      ? ` fill="${escapeXmlAttr(options.textFill)}"`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${formatCoord(width)}" height="${formatCoord(height)}" viewBox="${viewBoxAttr}"${textFillAttr}>${background}${body}</svg>`
}
