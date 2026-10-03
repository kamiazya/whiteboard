import { isImageRef } from './asset-ref.js'
import { frameBackground, nodeFile, nodeText } from './node-content.js'
import type { SpatialCanvas } from './spatial.js'

/**
 * What a document's stored content points at as UPLOADED PICTURES, as written
 * (`asset:<id>`), in the order it is met and without repeats.
 *
 * The one definition. What decides a blob's fate (the daemon's file GC, the
 * promote transfer) and what a render has to load (`imageTargets`, the
 * worker's reference wire) must agree on it, because the layout draws every
 * one of these: an image file node, a frame's background, and an inline
 * `![](asset:...)` in a text node or a markdown body. A reader that counts
 * fewer deletes or drops a picture a live document still shows.
 */
export function storedImageRefs(content: {
  readonly canvas?: SpatialCanvas
  readonly body?: string
}): readonly string[] {
  const refs = new Set<string>()
  const add = (ref: string) => {
    refs.add(ref)
  }
  if (content.body !== undefined) inlineImageRefs(content.body, add)
  for (const node of content.canvas?.nodes ?? []) {
    const file = nodeFile(node)
    const text = nodeText(node)
    const background = frameBackground(node)
    if (file !== undefined && isImageRef(file)) add(file)
    else if (text !== undefined) inlineImageRefs(text, add)
    if (background !== undefined && isImageRef(background)) add(background)
  }
  return [...refs]
}

/**
 * A markdown inline image whose URL is a stored asset, as written.
 *
 * A SCANNER rather than a parse: this runs over every body a walk reaches,
 * and parsing all of them to decide what to prefetch would charge a render
 * the markdown parser twice. What makes that safe is the direction of its
 * error — the LAYOUT reads mdast, so a URL this finds inside a code fence
 * costs one store read that answers nothing, while one it missed would be a
 * picture that silently does not draw, or a blob a purge deletes.
 *
 * `asset:` is the filter because it is what a keeper can actually answer. An
 * absolute URL already draws without resolution, and a bare relative path is
 * a different question — relative to what — that this does not decide.
 *
 * A hand scan rather than a REGEX: `/!\[[^\]]*\]\(/` re-attempts its inner
 * scan at every `![`, so a body of nothing but `![` is quadratic (measured
 * 6ms at 2000 repetitions, 2338ms at 40000) and a body is untrusted input.
 * The single cursor below never moves backwards, so every character is
 * examined a bounded number of times.
 */
function inlineImageRefs(body: string, add: (url: string) => void): void {
  if (!body.includes('](')) return
  for (let at = 0; at < body.length; ) {
    const bang = body.indexOf('![', at)
    if (bang === -1) return
    // The FIRST `](` after it. An alt text containing its own `]` therefore
    // reads as a malformed image and is skipped, which costs a load nobody
    // makes rather than a picture nobody sees.
    const close = body.indexOf('](', bang + 2)
    if (close === -1) return
    const destination = destinationAt(body, close + 2)
    if (destination === undefined) return
    if (isImageRef(destination.url)) add(destination.url)
    at = destination.end
  }
}

/** The link destination starting at `open`, and the index just past it. */
function destinationAt(body: string, open: number): { url: string; end: number } | undefined {
  if (body[open] === '<') {
    // `![a](<asset:two words>)`. The parser strips the brackets, so a scan
    // that kept them asked for a target nothing holds — and they are the
    // only destination syntax in which a SPACE is legal, so the plain stop
    // set below would cut one in half.
    const shut = body.indexOf('>', open + 1)
    if (shut === -1) return undefined
    return { url: body.slice(open + 1, shut), end: shut + 1 }
  }
  let end = open
  while (end < body.length && !')\t\n\r '.includes(body[end] as string)) end += 1
  return { url: body.slice(open, end), end }
}
