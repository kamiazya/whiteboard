import { useEffect, useRef, useState } from 'react'
import {
  browserMemoryScope,
  daemonMemoryScope,
} from '../components/workspace-files/use-device-memory.js'
import { browserWorkspaceIdOrNull } from '../lib/browser-workspace-id.js'
import { recordRecentDocument } from '../lib/recent-documents.js'
import { recordSeenDocument } from '../lib/seen-documents.js'

/**
 * Records that this device opened a document, whichever way it got there.
 *
 * The picker records a card click itself, but a document is also opened by
 * address, by reload, by a `[[link]]`, from search and from first-run Create,
 * and none of those pass through a card. Without this the document never
 * entered the Recent lane and carried the "changed" dot until someone
 * clicked its card.
 *
 * The seen baseline is the digest the LISTING names the document by — the
 * value the list later compares against — and is taken once per open, from
 * the first listing that carries one. Later digests are the person's own
 * edits (`use-own-edit-baseline.ts` follows those) or changes from
 * elsewhere, which must keep their dot.
 */
function useRememberOpen(
  scope: string | undefined,
  documentId: string | undefined,
  listedDigest: string | undefined,
): void {
  const recentKeyRef = useRef<string | null>(null)
  const seenKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (scope === undefined || documentId === undefined) return
    const key = `${scope}\u0000${documentId}`
    if (recentKeyRef.current !== key) {
      recentKeyRef.current = key
      recordRecentDocument(scope, documentId)
    }
    if (listedDigest !== undefined && seenKeyRef.current !== key) {
      seenKeyRef.current = key
      recordSeenDocument(scope, documentId, listedDigest)
    }
  }, [scope, documentId, listedDigest])
}

/**
 * The digest the browser keeper's index lists a document under, read once per
 * document. Undefined until it arrives, and for good when the read fails or
 * the index cannot derive one: a missing baseline reads as "no dot".
 */
function useBrowserListedDigest(
  index: {
    listDocuments(query: {
      workspaceId: string
    }): Promise<readonly { documentId: string; contentDigest?: string | undefined }[]>
  },
  workspaceId: string | null,
  documentId: string | null,
): string | undefined {
  const [found, setFound] = useState<{ documentId: string; digest: string } | null>(null)
  useEffect(() => {
    if (workspaceId === null || documentId === null) return
    let cancelled = false
    index.listDocuments({ workspaceId }).then(
      (entries) => {
        const digest = entries.find((entry) => entry.documentId === documentId)?.contentDigest
        if (!cancelled && digest !== undefined) setFound({ documentId, digest })
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [index, workspaceId, documentId])
  return found !== null && found.documentId === documentId ? found.digest : undefined
}

export function useBrowserRememberOpen(
  index: Parameters<typeof useBrowserListedDigest>[0],
  documentId: string | null,
): void {
  const workspaceId = browserWorkspaceIdOrNull()
  const digest = useBrowserListedDigest(index, workspaceId, documentId)
  useRememberOpen(
    workspaceId === null ? undefined : browserMemoryScope({ workspaceId }),
    documentId ?? undefined,
    digest,
  )
}

export function useDaemonRememberOpen(
  daemonBaseUrl: string,
  workspaceId: string | null,
  documentId: string | undefined,
  documents: readonly { readonly documentId: string; readonly contentDigest?: string }[] | null,
): void {
  const digest = documents?.find((entry) => entry.documentId === documentId)?.contentDigest
  useRememberOpen(
    workspaceId === null ? undefined : daemonMemoryScope(daemonBaseUrl, { workspaceId }),
    documentId,
    digest,
  )
}
