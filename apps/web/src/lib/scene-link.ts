/**
 * The renderer draws a reference as `<a href="<documentId>">`, and a canvas
 * embed as `#<documentId>`: an address only this app can resolve. Left to the
 * browser, the bare id resolves against the page URL and reloads the tab onto
 * a route that names no document. A link with a scheme, or one starting with
 * `/` (root- or protocol-relative), is a real URL from the markdown and is
 * not one of these: no document id starts with a slash.
 *
 * Answers the document id a click on a drawn scene landed on such a link
 * for, or `undefined` when the click was not on one.
 */
export function sceneLinkTarget(target: EventTarget | null): string | undefined {
  const anchor = target instanceof Element ? target.closest('a[href]') : null
  const href = anchor?.getAttribute('href')
  if (href == null || URL_SCHEME.test(href) || href.startsWith('/')) return undefined
  return href.replace(/^#/, '')
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
