/**
 * The contract a KEEPER answers so the one document page can render it.
 *
 * ADR-0004 decision 1 is one page; decision 2 is a controller layer selected
 * per keeper rather than unified. A `DocumentKeeper` is exactly that
 * selection made explicit: one hook that runs the keeper's controller, sync
 * backend, body and versions, and answers either the model the shared page
 * renders or a terminal screen of the keeper's own (its loading skeleton, a
 * degraded read, an empty workspace). `App` picks a keeper; nothing above
 * this contract knows which one it got.
 *
 * `useDocument` is a hook and is called as one — unconditionally, once per
 * render of the page. Mode is decided at page load (ADR-0004 decision 5), so
 * a page never changes keeper while mounted and the hook order holds.
 *
 * Mirrors `VersionsBackend` and `BranchesBackend` one level up: a seam with
 * two implementations and one contract suite run against both
 * (`test-utils/document-page.contract.tsx`), so a scenario written once is a scenario
 * both keepers answer.
 */
import type { ReactNode } from 'react'
import type { DocumentPageModel } from './document-page-model.js'

/** What the page tells a keeper it may raise; the page owns the state behind each. */
export interface DocumentKeeperEvents {
  /**
   * A version of this document was created — by this page's own save, by a
   * peer, by an agent. The page re-reads its history column.
   */
  readonly onVersionCreated: () => void
}

export type DocumentKeeperAnswer =
  | {
      readonly kind: 'render'
      readonly model: DocumentPageModel
      /**
       * Providers the keeper mounts AROUND the page — the browser's versions
       * and branches backends, the daemon's authorized fetch. Rendered by the
       * page so the keeper's hook stays a hook.
       */
      readonly wrap?: (page: ReactNode) => ReactNode
    }
  | {
      /** A screen of the keeper's own, drawn instead of the page: loading, degraded, empty. */
      readonly kind: 'terminal'
      readonly node: ReactNode
    }

export interface DocumentKeeper<Props> {
  readonly kind: 'browser' | 'daemon'
  useDocument(props: Props, events: DocumentKeeperEvents): DocumentKeeperAnswer
}
