import { useCallback, useMemo } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import { renameDocumentPath } from '../lib/daemon-api-client.js'
import { pathAfterFirstRename } from '../lib/first-rename-path.js'
import type { DaemonDocumentController } from './use-daemon-document-controller.js'

const log = getAppLogger('place-by-name')

/**
 * The daemon keeper's half of "the address follows the name once": after the
 * title box is left on a new name, moves the document from a generated path to
 * the name's, then points the page, the list and the address at it.
 *
 * The page's own path state moves BEFORE the address is told, so the editor
 * is already on the new path when the router reports it and nothing reloads
 * for the sake of the URL.
 */
export function usePlaceByName(
  controller: Pick<
    DaemonDocumentController,
    'workspaceId' | 'path' | 'documents' | 'switchDocument' | 'refreshDocuments'
  >,
  daemonFetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  onPathMoved: ((path: string) => void) | undefined,
): (name: string) => void {
  const { workspaceId, path, documents, switchDocument, refreshDocuments } = controller
  const existingPaths = useMemo(() => documents.map((document) => document.path), [documents])
  return useCallback(
    (name: string) => {
      if (workspaceId === null || path === null) return
      const to = pathAfterFirstRename(path, name, existingPaths)
      if (to === null) return
      renameDocumentPath(daemonFetch, daemonBaseUrl, workspaceId, path, to).then(
        () => {
          switchDocument(to)
          refreshDocuments()
          onPathMoved?.(to)
        },
        (err: unknown) => log.warn('placing a document by its name failed', err),
      )
    },
    [
      daemonFetch,
      daemonBaseUrl,
      workspaceId,
      path,
      existingPaths,
      switchDocument,
      refreshDocuments,
      onPathMoved,
    ],
  )
}
