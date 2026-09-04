import { createContext, useContext, useMemo } from 'react'
import { type BranchesBackend, createDaemonBranchesBackend } from '@/lib/branches-backend'
import { useDaemonApi } from './DaemonApiContext'

/**
 * Which keeper answers for a document's branches. `null` means "the daemon,
 * over whatever fetch `DaemonApiContext` carries" — so every daemon-backed
 * page and every existing test that mocks the daemon's routes keeps working
 * with no provider mounted. The browser page mounts one that has none.
 *
 * The fallback is the daemon rather than the browser deliberately, matching
 * `VersionsBackendContext`: an unmounted provider is a page that has not been
 * told, and on the daemon side that is the status quo, whereas defaulting to
 * "no branches" would silently disable a daemon page's chip.
 */
export const BranchesBackendContext = createContext<BranchesBackend | null>(null)

export function useBranchesBackend(): BranchesBackend {
  const provided = useContext(BranchesBackendContext)
  const daemonFetch = useDaemonApi()
  // Memoised on the fetch so consumers can list it in effect deps without
  // refetching on every render.
  const fallback = useMemo(() => createDaemonBranchesBackend(daemonFetch), [daemonFetch])
  return provided ?? fallback
}
