import { createContext, useContext, useMemo } from 'react'
import { createDaemonVersionsBackend, type VersionsBackend } from '../lib/versions-backend.js'
import { useDaemonApi } from './DaemonApiContext'

/**
 * Which keeper answers for a document's version history. `null` means "the
 * daemon, over whatever fetch `DaemonApiContext` carries" — so every
 * daemon-backed page and every existing test that mocks the daemon's routes
 * keeps working with no provider mounted. The browser page mounts one over
 * its IndexedDB store.
 */
export const VersionsBackendContext = createContext<VersionsBackend | null>(null)

export function useVersionsBackend(): VersionsBackend {
  const provided = useContext(VersionsBackendContext)
  const daemonFetch = useDaemonApi()
  // Memoised on the fetch so consumers can list it in effect deps without
  // refetching on every render.
  const fallback = useMemo(() => createDaemonVersionsBackend(daemonFetch), [daemonFetch])
  return provided ?? fallback
}
