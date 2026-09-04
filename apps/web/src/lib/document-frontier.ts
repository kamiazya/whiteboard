/**
 * One definition of "which state is this document in".
 *
 * It exists as its own module because two different owners hold a document in
 * this app — `DocumentSyncSession` for a synced one, `useMarkdownDocument`
 * for a browser-kept markdown one — and a picture derived from either is
 * memoised under this value. Two hand-written encodings would be two answers
 * to the same question, and the one that drifted would file a picture under a
 * version that is not its own.
 *
 * NOT in `document-outline.ts`, which the layout worker imports: that would
 * pull loro-crdt's WASM into the worker at module load and undo the lazy
 * import that keeps every markdown render from paying for it.
 *
 * The STATE frontier rather than the oplog's — a document checked out to an
 * older version SHOWS that version, and an oplog-derived id would claim the
 * newest. Measured before choosing: it moves on every edit and does not move
 * on a commit that changed nothing.
 */

import { encodeFrontiers, type LoroDoc } from 'loro-crdt'

/** Just the part of LoroDoc this needs, so a caller's own doc type fits. */
type FrontierBearing = Pick<LoroDoc, 'frontiers'>

export function frontierOf(doc: FrontierBearing): string {
  // `btoa` over the raw bytes: the value only has to be stable and
  // comparable, and it is encoded again before it reaches a path.
  return btoa(String.fromCharCode(...new Uint8Array(encodeFrontiers(doc.frontiers()))))
}
