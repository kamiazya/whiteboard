/**
 * Which owner holds THIS document, for the surfaces that draw its shape.
 *
 * Two of them exist in the browser page and only one of them is obvious. A
 * synced document lives in `DocumentSyncSession`; a browser-kept MARKDOWN
 * document lives in `useMarkdownDocument`'s own LoroDoc and never reaches
 * that session at all. Asking the session alone therefore answers `null` for
 * every browser markdown document — which is not a crash and not a failing
 * test, just a tab icon that never changes however much is typed. It was
 * found by opening the app, and nothing else would have found it: every test
 * of the hook above injects its source and so never exercises this choice.
 *
 * The daemon page has one owner (its markdown body comes through the sync
 * session), so it passes the session's reader straight through and this
 * function is the browser page's business.
 */

import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentOutlineSource } from './document-outline.js'
import { contentStateOf, type StateBearing } from './document-state.js'
import { unhandledKind } from './exhaustive.js'

/** Just the part of the markdown document state this needs. */
export interface MarkdownOwner {
  readonly doc: StateBearing | null
  readonly body: string | null
}

export function composeOutlineSource(
  kind: DocumentKind,
  fromSession: (kind: DocumentKind) => DocumentOutlineSource | null,
  markdown: MarkdownOwner,
): DocumentOutlineSource | null {
  switch (kind) {
    case 'spatial':
      return fromSession(kind)
    case 'markdown': {
      // The session gets first refusal even here: where it DOES hold the
      // document (the daemon page's shape), its answer is authoritative.
      const synced = fromSession(kind)
      if (synced !== null) return synced
      if (markdown.doc === null || markdown.body === null) return null
      // Both out of the same doc, in one synchronous block — the pairing the
      // key depends on.
      return { state: contentStateOf(markdown.doc), body: markdown.body }
    }
    default:
      // A new kind has to name its owner HERE. Falling through to the
      // session is what silently answered `null` for every browser markdown
      // document, and the icon simply never changed.
      return unhandledKind(kind, 'composeOutlineSource')
  }
}
