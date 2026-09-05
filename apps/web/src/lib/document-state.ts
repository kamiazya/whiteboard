/**
 * One definition of "which state is this document in", for every rendition
 * of it — the favicon, a tree row's icon, a list row's thumbnail.
 *
 * The same function the workspace listing uses for `contentDigest`, applied
 * to a document whose containers are roots of its own Loro document — an
 * editor session's, or a browser-kept markdown document's. That is the whole
 * point: a list row and the open document's own icon used to name the same
 * content two ways (a content digest and the state frontier), so nothing
 * drawn for one was ever shared with the other. Measured before unifying:
 * once empty containers are normalised away, a tree node, a projection and a
 * fresh document digest identically for the same content.
 *
 * A digest of the document's LIVE state — `toJSON()`, which reflects an edit
 * the moment it is written, committed or not (measured: it moves at the
 * write and not again at the commit). What that buys depends on the owner.
 * The markdown binding writes each keystroke into the text container, so its
 * key moves with the keystroke. The sync session DEFERS its write: `onChange`
 * publishes the canvas at once and writes the document on a debounce, so
 * between the two the published value is ahead of the document — the key and
 * the bytes still describe one state, because both are read from the
 * document, and it is the published value that has not landed yet. The
 * document's own change notification, which fires after that write, is what
 * a surface keyed here has to listen to.
 *
 * NOT in `document-outline.ts`, which the layout worker imports: loro-adapter
 * pulls loro-crdt's WASM in at module load, and the worker imports it lazily
 * so a markdown render never pays for it.
 */

import { contentDigestOfDocument } from '@kamiazya/whiteboard-loro-adapter'

/** Just the part of a Loro document this needs, so a caller's own doc type fits. */
export type StateBearing = Parameters<typeof contentDigestOfDocument>[0]

export function contentStateOf(doc: StateBearing): string {
  return contentDigestOfDocument(doc)
}
