import { useMemo } from 'react'
import {
  browserMemoryScope,
  daemonMemoryScope,
} from '../components/workspace-files/use-device-memory.js'
import { browserWorkspaceIdOrNull } from '../lib/browser-workspace-id.js'
import type { UseDocumentSyncOptions } from '../lib/document-sync-types.js'
import { recordSeenDocument } from '../lib/seen-documents.js'

/**
 * The seen-baseline writer, as the `useDocumentSync` option fragment to spread for the document a page has open.
 *
 * The document list's "changed" dot compares a listing's digest with the one
 * recorded when the person opened the document. Their own edit moves the
 * digest, so without this the dot lights up on the very document they just
 * came back from. The session announces the state only after the person's own
 * edit has been written (never an import), so a change that arrived from
 * elsewhere keeps its dot.
 *
 * Bound to the document it was built for and handed to the session at
 * construction: the final edit is written during teardown, after the page may
 * already name another document.
 */
type OwnEditOption = Pick<UseDocumentSyncOptions, 'onOwnEditContentState'>

function useBaselineWriter(
  scope: string | undefined,
  documentId: string | undefined,
): OwnEditOption {
  return useMemo(() => {
    if (scope === undefined || documentId === undefined) return {}
    return {
      onOwnEditContentState: (contentState: string) =>
        recordSeenDocument(scope, documentId, contentState),
    }
  }, [scope, documentId])
}

export function useBrowserOwnEditBaseline(documentId: string | null): OwnEditOption {
  const workspaceId = browserWorkspaceIdOrNull()
  return useBaselineWriter(
    workspaceId === null ? undefined : browserMemoryScope({ workspaceId }),
    documentId ?? undefined,
  )
}

/**
 * `contentDocumentId` is set for the daemon's workspace-scoped session; an
 * injected per-document backend has none, and the listing names the document
 * by path instead.
 */
export function useDaemonOwnEditBaseline(
  daemonBaseUrl: string,
  workspaceId: string | null,
  path: string | null,
  contentDocumentId: string | undefined,
  documents: readonly { readonly path: string; readonly documentId: string }[] | null,
): OwnEditOption {
  const documentId =
    contentDocumentId ?? documents?.find((entry) => entry.path === path)?.documentId
  return useBaselineWriter(
    workspaceId === null ? undefined : daemonMemoryScope(daemonBaseUrl, { workspaceId }),
    documentId,
  )
}
