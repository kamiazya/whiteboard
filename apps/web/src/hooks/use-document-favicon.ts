/**
 * The tab-identity favicon wiring, shared by the browser and daemon
 * document pages (previously duplicated statement-for-statement — the third
 * page-unification extraction after `useVersionSaveFlow` and
 * `useCommentsRail`). What stays keeper-specific arrives as VALUES: the
 * status (`browserFaviconStatus` / `daemonFaviconStatus`), the document
 * identity, the revision trigger, and the outline reader.
 */

import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'
import type { DocumentOutlineSource } from '../lib/document-outline.js'
import type { FaviconStatus, FaviconStyle } from '../lib/favicon.js'
import { createInTabRenderBroker } from '../lib/render-broker.js'
import type { UserSettingsStore } from '../lib/user-settings-store.js'
import { useDocumentOutline } from './useDocumentOutline.js'
import { useFavicon } from './useFavicon.js'

export function useDocumentFavicon({
  settingsStore,
  documentId,
  kind,
  revision,
  readSource,
  status,
}: {
  settingsStore: UserSettingsStore
  documentId: string | null
  kind: DocumentKind
  /**
   * Whatever the page re-renders with when this document changes — its
   * canvas value or its body. Identity-only trigger; see useDocumentOutline.
   */
  revision: unknown
  readSource: (kind: DocumentKind) => DocumentOutlineSource | null
  status: FaviconStatus
}): void {
  // Read once per render, effectively once at mount: the routed /settings
  // page is the only place the style toggles, and navigating there and back
  // remounts the page — no in-mount reactivity needed.
  const faviconStyle: FaviconStyle = settingsStore.load().appearance?.faviconStyle ?? 'minimap'

  // One broker per page mount, for the tab icon's outline. It is the same
  // seam the list surfaces ask through (ADR-0027); what it buys HERE is that
  // a re-render, a sync-status change or a remount does not recompute a
  // shape the document already has — the version key is what makes that safe.
  const outlineBroker = useMemo(() => createInTabRenderBroker(), [])

  const documentOutline = useDocumentOutline({
    documentId,
    kind,
    revision,
    readSource,
    broker: outlineBroker,
  })

  useFavicon({
    style: faviconStyle,
    status,
    rects: documentOutline,
  })
}
