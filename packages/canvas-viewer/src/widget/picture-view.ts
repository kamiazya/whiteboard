// How the widget shows the picture the daemon laid out (ADR-0054 step 7,
// q54): it parses the SVG, checks it, and places it — nothing is laid out
// here.
//
// Parsed rather than injected as markup. canvas-render's serializer is still
// the only producer of the string and escapes what it writes, but that
// serializer now runs in another process and the string reaches this frame
// through the host, so the argument `SceneSvg` rests on is no longer one this
// frame can see. A parser builds no script that runs, and the check below
// refuses the ways a parsed SVG can still act when it is placed: a
// script-bearing element, an event-handler attribute, a `javascript:` link,
// and an animation element, which can write an attribute (a link's `href`)
// after the check has run.
// Nothing the serializer writes is any of them, so a refusal is never a
// drawing lost — it is a string that did not come from the serializer.

const SVG_NS = 'http://www.w3.org/2000/svg'
const ACTIVE_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'set',
  'animate',
  'animatemotion',
  'animatetransform',
])
const SCRIPT_URL = /^\s*javascript:/i
// The URL Standard strips ASCII tab and newline anywhere in a URL before it
// reads the scheme, so `java&#xA;script:` is a script link once parsed.
const URL_STRIPPED = /[\t\n\r]/g

/** Whether one parsed element could run anything once placed in the document. */
function isActive(element: Element): boolean {
  if (ACTIVE_ELEMENTS.has(element.localName.toLowerCase())) return true
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.toLowerCase().startsWith('on')) return true
    if (
      attribute.localName === 'href' &&
      SCRIPT_URL.test(attribute.value.replace(URL_STRIPPED, ''))
    )
      return true
  }
  return false
}

/**
 * The picture's SVG as an element ready to place, or `undefined` for a string
 * that is not an SVG document or holds anything that could run.
 */
export function pictureSvgElement(svg: string): SVGSVGElement | undefined {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') return undefined
  if (parsed.getElementsByTagName('parsererror').length > 0) return undefined
  if (isActive(root) || Array.from(root.querySelectorAll('*')).some(isActive)) return undefined
  const element = document.importNode(root, true) as unknown as SVGSVGElement
  // The envelope's width and height are the scene's own extent; the frame is
  // the widget's, so the picture scales to it and keeps its proportions.
  element.setAttribute('width', '100%')
  element.setAttribute('height', '100%')
  return element
}

/**
 * Whether the picture declares `family` anywhere: the daemon names a theme's
 * family only where it measured with it, so a face the picture does not name
 * is a download nothing would draw with.
 */
export function pictureDeclaresFamily(element: SVGSVGElement, family: string): boolean {
  const named = (value: string | null) =>
    value?.split(',').some((part) => part.trim().replace(/^["']|["']$/g, '') === family) === true
  if (named(element.getAttribute('font-family'))) return true
  return Array.from(element.querySelectorAll('[font-family]')).some((node) =>
    named(node.getAttribute('font-family')),
  )
}

export interface PictureHandle {
  dispose: () => void
}

/**
 * Places the picture in `container` inside a named `<figure>` — not
 * `role="img"`, which would mark the SVG's text runs presentational, and they
 * are the only way a screen reader reaches what the board says. The name is
 * the host's, never the canvas's: a document's name lives in the workspace.
 */
export function mountPicture(
  container: HTMLElement,
  element: SVGSVGElement,
  label = 'Canvas',
): PictureHandle {
  const figure = document.createElement('figure')
  figure.setAttribute('aria-label', label)
  figure.dataset.testid = 'canvas-viewer'
  figure.style.width = '100%'
  figure.style.height = '100%'
  figure.style.overflow = 'hidden'
  figure.style.margin = '0'
  figure.append(element)
  container.append(figure)
  return { dispose: () => figure.remove() }
}
