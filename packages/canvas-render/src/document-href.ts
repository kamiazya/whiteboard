import { documentIdSchema } from '@kamiazya/whiteboard-model'

/**
 * How a drawn scene addresses a document: a wiki link is drawn as
 * `<a href="<documentId>">` and an embed placeholder as
 * `<a href="#<documentId>">` — addresses only the host application can
 * resolve, which a browser left to itself follows as a relative URL. Every
 * surface that mounts scene SVG therefore has to tell these apart from an
 * ordinary markdown link, and they must all draw the line in the same place.
 *
 * The line is the document-id grammar itself, not "has no scheme": a
 * relative markdown link (`guide.md`, `plan`) also has no scheme, and names
 * no document id.
 *
 * The document a drawn scene's `href` addresses, or `undefined` when it is
 * an ordinary link — a URL with a scheme, a path, a relative file — that the
 * host should leave to the browser.
 */
export function documentIdOfHref(href: string | null | undefined): string | undefined {
  if (href == null) return undefined
  const candidate = href.startsWith('#') ? href.slice(1) : href
  return documentIdSchema.safeParse(candidate).success ? candidate : undefined
}
