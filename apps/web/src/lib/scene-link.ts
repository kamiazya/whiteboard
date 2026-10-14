import { documentIdOfHref } from '@kamiazya/whiteboard-canvas-render'

/**
 * The document a click on a drawn scene landed on a link to, or `undefined`
 * when it did not land on one. Which hrefs address a document is the
 * renderer's to say (`documentIdOfHref`, beside the code that writes them);
 * this only finds the anchor the click was inside.
 *
 * Left to the browser, a document link resolves against the page URL and
 * reloads the tab onto a route that names no document, so every surface that
 * mounts scene SVG cancels a click this answers for.
 */
export function sceneLinkTarget(target: EventTarget | null): string | undefined {
  const anchor = target instanceof Element ? target.closest('a[href]') : null
  return documentIdOfHref(anchor?.getAttribute('href'))
}

/**
 * Answers a click on a drawn scene the way an editing surface must: a click
 * on a document link is always cancelled, and opens the document through
 * `open` when the host has somewhere to open it. Any other link keeps the
 * browser's default, as an ordinary link in the markdown preview does.
 */
export function openSceneLink(
  event: { readonly target: EventTarget | null; preventDefault(): void },
  open: ((documentId: string) => void) | undefined,
): void {
  const documentId = sceneLinkTarget(event.target)
  if (documentId === undefined) return
  event.preventDefault()
  open?.(documentId)
}
