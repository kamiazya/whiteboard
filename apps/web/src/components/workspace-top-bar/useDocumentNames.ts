import {
  apiErrorReason,
  type WorkspaceNames,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useCallback, useEffect, useState } from 'react'
import {
  DaemonApiError,
  getWorkspaceNames,
  setDocumentDisplayName,
} from '../../lib/daemon-api-client.js'
import { useRenameQueue } from './use-rename-queue.js'

/** `daemonFetch` already resolves a route against the daemon it was built for. */
const SAME_BASE = ''

const EMPTY_NAMES: WorkspaceNames = { documents: {}, pinned: [] }

/** What a refused rename says when the daemon could not be asked or gave no reason. */
const RENAME_REFUSED = 'Could not rename it.'

interface UseDocumentNamesOptions {
  workspaceId: string
  /**
   * A browser-kept workspace has no daemon to ask for `/names`, and nothing else to ask
   * either: the browser page names its document through its own store
   * and hands the header the result, so this hook simply stays empty there.
   */
  keptByBrowser: boolean
  daemonFetch: typeof globalThis.fetch
  /**
   * What the workspace record the page syncs names the open document — the
   * same record `/names` answers from, kept current by its update frames.
   * `name` is `null` for an unnamed document and `undefined` while the record
   * cannot say. Read once at open, `/names` stayed stale for a name the
   * daemon seeded from a heading, an agent's rename, or another tab's.
   */
  recorded?: { readonly path: string; readonly name: string | null | undefined }
}

/** `names` with the record's word on one document, where it has one. */
function withRecordedName(
  names: WorkspaceNames,
  recorded: UseDocumentNamesOptions['recorded'],
): WorkspaceNames {
  if (recorded?.name === undefined) return names
  const { [recorded.path]: _previous, ...others } = names.documents
  const documents = recorded.name === null ? others : { ...others, [recorded.path]: recorded.name }
  return { ...names, documents }
}

/**
 * One rename commit: null once saved, else why not (the daemon's own reason
 * when its refusal carried one; anything else — unreached, a reasonless
 * refusal, a drifted answer — in this module's words).
 */
async function writeName(
  daemonFetch: typeof globalThis.fetch,
  workspaceId: string,
  targetPath: string,
  name: string,
  setNames: (names: WorkspaceNames) => void,
): Promise<string | null> {
  try {
    setNames(await setDocumentDisplayName(daemonFetch, SAME_BASE, workspaceId, targetPath, name))
    return null
  } catch (err) {
    return (err instanceof DaemonApiError && apiErrorReason(err.body)) || RENAME_REFUSED
  }
}

// Single owner of the workspaceNamesSchema-derived names state. Callers get
// `effectiveNames` and the writer below rather than a setter — keeping the
// schema-parse boundary in one place is what stops a future caller from
// writing an un-validated shape into this state.
export function useDocumentNames({
  workspaceId,
  keptByBrowser,
  daemonFetch,
  recorded,
}: UseDocumentNamesOptions) {
  const [names, setNames] = useState<WorkspaceNames>(EMPTY_NAMES)
  const { track, afterRenamesLand } = useRenameQueue()

  // Load display names. Guard against a stale response for a previous
  // workspaceId landing after a newer request already resolved.
  useEffect(() => {
    if (keptByBrowser) return
    let active = true
    ;(async () => {
      try {
        const read = await getWorkspaceNames(daemonFetch, SAME_BASE, workspaceId)
        if (active) setNames(read)
      } catch {
        /* best-effort */
      }
    })()
    return () => {
      active = false
    }
    // daemonFetch is stable per identity (apiFetch, or the page's memoized
    // createDaemonFetch), so this refetches only for a new base URL or token.
  }, [workspaceId, daemonFetch, keptByBrowser])

  const effectiveNames = keptByBrowser ? EMPTY_NAMES : withRecordedName(names, recorded)

  // Daemon-mode rename commit: null once saved, else why not (the daemon's own
  // reason when it gave one). A browser-kept workspace never reaches it.
  const renameDocument = useCallback(
    (targetPath: string, name: string): Promise<string | null> =>
      track(() => writeName(daemonFetch, workspaceId, targetPath, name, setNames)),
    [workspaceId, daemonFetch, track],
  )

  /** What the title slot is handed to rename this document with, and to wait on those renames. */
  const renameFor = (path: string) => ({
    onRename: (next: string) => renameDocument(path, next),
    afterRenamesLand,
  })

  return { effectiveNames, renameDocument, renameFor }
}
