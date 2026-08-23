import type { ConnectionState } from '../components/connection/ConnectionStatus.js'

/**
 * What the page holding a live document session knows about its connection.
 *
 * The AppShell is mounted once per App branch, above the routed pages, so a
 * page cannot pass this as a prop. This module store is that channel; keep it
 * to shell concerns only.
 */
export interface ShellConnection {
  readonly state: ConnectionState
  /** Named in the synced popover, and the target of repair/disconnect. */
  readonly daemonBaseUrl?: string
}

/**
 * `null` means no page holds a live session, and the shell then shows no chip
 * rather than inventing a state for one. A daemon INDEX page does talk to the
 * daemon over HTTP, but it runs no document sync — so neither "Synced" nor
 * "Reconnecting" is a true thing to say there.
 */
let connection: ShellConnection | null = null
const listeners = new Set<() => void>()

export function subscribeShellStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getShellConnection(): ShellConnection | null {
  return connection
}

export function setShellConnection(next: ShellConnection | null): void {
  // Compared field by field, never by identity: useSyncExternalStore reads a
  // fresh object as a change, so publishing from a render-scoped effect would
  // otherwise re-render the shell on every page render.
  if (next?.state === connection?.state && next?.daemonBaseUrl === connection?.daemonBaseUrl) return
  connection = next
  for (const listener of listeners) listener()
}

export function resetShellStatusForTests(): void {
  connection = null
  listeners.clear()
}
