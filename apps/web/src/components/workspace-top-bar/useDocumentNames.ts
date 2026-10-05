import {
  documentNameApiUrl,
  type setNameRequestSchema,
  type WorkspaceNames,
  workspaceNamesApiUrl,
  workspaceNamesSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { refusalReasonOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/refusal-reason'
import { useCallback, useEffect, useState } from 'react'
import type { z } from 'zod'
import { parseDaemonResponse } from '../../lib/daemon-contract-error.js'

/** Both the read and the rename answer with the workspace's names; a skew in either is reported with its route. */
async function readNames(route: string, res: Response): Promise<WorkspaceNames> {
  return parseDaemonResponse(route, workspaceNamesSchema, await res.json())
}

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

  // Load display names. Guard against a stale response for a previous
  // workspaceId landing after a newer request already resolved.
  useEffect(() => {
    if (keptByBrowser) return
    let active = true
    ;(async () => {
      try {
        const res = await daemonFetch(workspaceNamesApiUrl(workspaceId))
        if (res.ok && active) setNames(await readNames(workspaceNamesApiUrl(workspaceId), res))
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
    async (targetPath: string, name: string): Promise<string | null> => {
      try {
        const res = await daemonFetch(documentNameApiUrl(workspaceId, targetPath), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name } satisfies z.infer<typeof setNameRequestSchema>),
        })
        if (res.ok) {
          setNames(await readNames(documentNameApiUrl(workspaceId, targetPath), res))
          return null
        }
        return (await refusalReasonOf(res, RENAME_REFUSED)).reason
      } catch {
        return RENAME_REFUSED
      }
    },
    [workspaceId, daemonFetch],
  )

  return { effectiveNames, renameDocument }
}
