import { apiFetch } from '@kamiazya/whiteboard-daemon-client/api-client'
import { createContext, useContext } from 'react'

/**
 * Carries the daemon-origin-aware fetch (createDaemonFetch(...)) down to any
 * component that needs to call the daemon's /api/... endpoints. `null` means
 * "no daemon provider mounted" — useDaemonApi() falls back to the default
 * same-origin apiFetch so browser pages and the same-origin
 * mcp-server app keep working unmodified.
 */
export const DaemonApiContext = createContext<typeof globalThis.fetch | null>(null)

export function useDaemonApi(): typeof globalThis.fetch {
  return useContext(DaemonApiContext) ?? apiFetch
}

/**
 * True when a DaemonApiContext.Provider is mounted above this component.
 * Lets a consumer branch on same-origin vs. cross-origin daemon access — for
 * example, VersionTimeline's thumbnail <img> cannot carry a daemon origin or
 * bearer token, so it only renders in the same-origin (no provider) case.
 */
export function useHasDaemonApi(): boolean {
  return useContext(DaemonApiContext) !== null
}
