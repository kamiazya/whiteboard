import {
  documentsApiUrl,
  type WorkspaceNames,
  workspaceNamesSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { useCallback, useEffect, useState } from 'react'

const EMPTY_NAMES: WorkspaceNames = { documents: {}, pinned: [] }

interface UseDocumentNamesOptions {
  workspaceId: string
  /**
   * Local mode has no daemon to ask for `/names`, and nothing else to ask
   * either: the browser-local page names its document through its own store
   * and hands the header the result, so this hook simply stays empty there.
   */
  isLocalMode: boolean
  daemonFetch: typeof globalThis.fetch
}

// Single owner of the workspaceNamesSchema-derived names state. Callers get
// `effectiveNames` and the writer below rather than a setter — keeping the
// schema-parse boundary in one place is what stops a future caller from
// writing an un-validated shape into this state.
export function useDocumentNames({
  workspaceId,
  isLocalMode,
  daemonFetch,
}: UseDocumentNamesOptions) {
  const [names, setNames] = useState<WorkspaceNames>(EMPTY_NAMES)

  // Load display names. Guard against a stale response for a previous
  // workspaceId landing after a newer request already resolved.
  useEffect(() => {
    if (isLocalMode) return
    let active = true
    ;(async () => {
      try {
        const res = await daemonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/names`)
        if (res.ok && active) setNames(workspaceNamesSchema.parse(await res.json()))
      } catch {
        /* best-effort */
      }
    })()
    return () => {
      active = false
    }
    // daemonFetch is stable per identity (module-level apiFetch, or the daemon
    // page's memoized createDaemonFetch result), so including it does not
    // refetch per render — and a genuinely new fetch identity (base URL or
    // token change) must refetch to avoid serving stale names.
  }, [workspaceId, daemonFetch, isLocalMode])

  const effectiveNames = isLocalMode ? EMPTY_NAMES : names

  // Daemon-mode rename commit. Returns whether the PUT succeeded so the
  // caller can decide how to react; local mode never reaches it.
  const renameDocument = useCallback(
    async (targetPath: string, name: string): Promise<boolean> => {
      try {
        const res = await daemonFetch(documentsApiUrl(workspaceId, targetPath, 'name'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (res.ok) {
          setNames(workspaceNamesSchema.parse(await res.json()))
          return true
        }
        return false
      } catch {
        return false
      }
    },
    [workspaceId, daemonFetch],
  )

  return { effectiveNames, renameDocument }
}
