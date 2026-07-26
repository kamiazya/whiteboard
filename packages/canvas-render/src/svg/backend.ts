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
  return `<g>${item.children.map(renderNode).join('')}</g>`
}

function renderTableCell(cell: TableCellSceneNode): string {
  return `<g>${cell.runs.map(renderTextRun).join('')}</g>`
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
      return `<g>${node.svg}</g>`
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
 * Serializes a decorated scene to an SVG string. Pure, no DOM — the same
 * implementation runs on Node, in the browser, and on Workers. Output
 * follows the canonical serialization rules (fixed attribute order,
 * consistent escaping, single root `xmlns`, one number formatter) so the
 * same scene produces byte-identical SVG everywhere.
 */
export function renderSceneToSvg(scene: Scene): string {
  const body = scene.nodes.map(renderNode).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`
}
