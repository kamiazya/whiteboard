import { sceneBounds } from '../scene-bounds.js'
import type {
  BoundingBox,
  ListItemNode,
  Scene,
  SceneNode,
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

function renderTextRun(run: TextRunNode): string {
  const attrs = [`x="${formatCoord(run.bbox.x)}"`, `y="${formatCoord(run.bbox.y)}"`]
  if (run.link) {
    const href = run.link.kind === 'link' ? sanitizeHref(run.link.href) : run.link.canvasId
    return `<a href="${escapeXmlAttr(href)}"><text ${attrs.join(' ')}>${escapeXmlText(run.text)}</text></a>`
  }
  return `<text ${attrs.join(' ')}>${escapeXmlText(run.text)}</text>`
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
    case 'svgFragment':
      // Precondition: the caller has already validated `svg` is well-formed
      // XML before constructing this node — emitted verbatim, not escaped.
      return node.role === 'presentation'
        ? `<g ${PRESENTATION_ATTR}>${node.svg}</g>`
        : `<g>${node.svg}</g>`
    case 'embedPlaceholder':
      return `<a href="#${escapeXmlAttr(node.canvasId)}"><text ${rectAttrs(node.bbox)}>${escapeXmlText(node.title)}</text></a>`
    case 'embedResolved':
      return `<g>${node.children.map(renderNode).join('')}</g>`
    case 'edge': {
      const points = node.path.map((p) => `${formatCoord(p.x)},${formatCoord(p.y)}`).join(' ')
      return `<polyline points="${points}" ${PRESENTATION_ATTR}/>`
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
    options.background !== undefined
  )
}

function isFiniteBox(box: BoundingBox): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite)
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
  if (options.viewBox && isFiniteBox(options.viewBox)) return options.viewBox
  return expandBox(sceneBounds(scene), sanitizePadding(options.padding))
}

function resolveDimension(explicit: number | undefined, fallback: number): number {
  return explicit !== undefined && Number.isFinite(explicit) ? explicit : fallback
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
 * envelope: fixed root-attribute order `xmlns width height viewBox`, plus a
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${formatCoord(width)}" height="${formatCoord(height)}" viewBox="${viewBoxAttr}">${background}${body}</svg>`
}
