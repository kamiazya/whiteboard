import { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
import { createContext, useContext } from 'react'

/**
 * Carries the daemon-origin-aware fetch (createDaemonFetch(...)) down to any
 * component that needs to call the daemon's /api/... endpoints. `null` means
 * "no daemon provider mounted" — useDaemonApi() falls back to the default
 * same-origin apiFetch so browser-local pages and the same-origin
 * mcp-server app keep working unmodified.
 */
export const DaemonApiContext = createContext<typeof globalThis.fetch | null>(null)

export function useDaemonApi(): typeof globalThis.fetch {
  return useContext(DaemonApiContext) ?? apiFetch
}
