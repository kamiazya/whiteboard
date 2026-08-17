import {
  documentsApiUrl,
  type WorkspaceNames,
  workspaceNamesSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocumentInfo } from './types'

const EMPTY_NAMES: WorkspaceNames = { documents: {}, pinned: [] }

interface UseDocumentNamesOptions {
  workspaceId: string
  documents: DocumentInfo[]
  // Local mode has no daemon to ask for /names — display names come from
  // documents[].name instead, and rename/pin never PUT to the daemon.
  isLocalMode: boolean
  daemonFetch: typeof globalThis.fetch
}

// Single owner of the workspaceNamesSchema-derived names state. Every other
// module (DocumentDropdown, DocumentItem, the rename input) receives
// `effectiveNames` and the two writer callbacks below rather than a setter —
// keeping the schema-parse boundary in one place is what stops a future
// caller from writing an un-validated shape into this state.
export function useDocumentNames({
  workspaceId,
  documents,
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

  // Local-mode display names come straight from the caller-provided
  // documents array rather than the daemon's /names response.
  const localNames = useMemo<WorkspaceNames>(() => {
    if (!isLocalMode) return EMPTY_NAMES
    const byId: Record<string, string> = {}
    for (const c of documents) {
      if (c.name) byId[c.path] = c.name
    }
    return { documents: byId, pinned: [] }
  }, [isLocalMode, documents])

  const effectiveNames = isLocalMode ? localNames : names

  // Daemon-mode rename commit. Returns whether the PUT succeeded so the
  // caller can decide how to react (the local-mode rename path is entirely
  // separate — it calls the host page's onRenameDocument instead).
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

  // Toggle pin state and replace local state with the server response.
  // This intentionally avoids optimistic UI because rollback is not worth the added complexity.
  const togglePin = useCallback(
    async (targetPath: string, pinned: boolean) => {
      try {
        const res = await daemonFetch(documentsApiUrl(workspaceId, targetPath, 'pin'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned }),
        })
        if (res.ok) setNames(workspaceNamesSchema.parse(await res.json()))
      } catch {
        /* Pin failures stay silent; the UX does not need explicit retry handling here. */
      }
    },
    [workspaceId, daemonFetch],
  )

  return { effectiveNames, renameDocument, togglePin }
}
