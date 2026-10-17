import type { WorkspaceSummary } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useCallback, useRef } from 'react'
import { workspaceHandle } from '../lib/workspace-handle.js'

/**
 * The address a listed workspace is reported under: its in-app form
 * (`<namespace>/<segment>`, ADR-0053) once the list names it, its id until
 * then. Requests name the id; only the URL carries the address, so a page that
 * selects by id derives the address here whenever it reports one.
 *
 * Stable across renders: it reads the latest list through a ref, so a caller
 * can keep it out of an effect's dependencies without reading a stale list.
 */
export function useWorkspaceAddressOf(
  workspaces: readonly WorkspaceSummary[],
): (workspaceId: string) => string {
  const latest = useRef(workspaces)
  latest.current = workspaces
  return useCallback((workspaceId: string) => {
    const entry = latest.current.find((w) => w.workspaceId === workspaceId)
    return entry === undefined ? workspaceId : workspaceHandle(entry)
  }, [])
}
