import type { ConnectionState } from './connection-state.js'
import { createSubscribers } from './subscribers.js'
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
  /**
   * browser keeper: when the open document's writes last landed, ISO-8601.
   * The popover's answer to "is it saved" — the mark itself draws nothing
   * for a write that landed.
   */
  readonly lastWrittenAt?: string | null
}

/**
 * `null` means no page holds a live session, and the shell then shows no chip
 * rather than inventing a state for one. A daemon INDEX page does talk to the
 * daemon over HTTP, but it runs no document sync — so neither "Synced" nor
 * "Reconnecting" is a true thing to say there.
 */
let connection: ShellConnection | null = null
const changed = createSubscribers()

export const subscribeShellStatus = changed.subscribe

export function getShellConnection(): ShellConnection | null {
  return connection
}

// Compared field by field, never by identity: useSyncExternalStore reads a
// fresh object as a change, so publishing from a render-scoped effect would
// otherwise re-render the shell on every page render — and the state is an
// object now, so the comparison has to reach into both of its axes. Each
// keeper varies on its own health field, so each is compared on that one: a
// shortcut that treats a keeper as "always the same" swallows exactly the
// transition (a refused browser write) the shell exists to show.
function sameState(a: ConnectionState, b: ConnectionState): boolean {
  if (a.keeper === 'browser') return b.keeper === 'browser' && a.storage === b.storage
  return b.keeper === 'daemon' && a.session === b.session
}

function sameConnection(a: ShellConnection | null, b: ShellConnection | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.daemonBaseUrl === b.daemonBaseUrl &&
    (a.lastWrittenAt ?? null) === (b.lastWrittenAt ?? null) &&
    sameState(a.state, b.state)
  )
}

export function setShellConnection(next: ShellConnection | null): void {
  if (sameConnection(next, connection)) return
  connection = next
  changed.emit()
}

export function resetShellStatusForTests(): void {
  connection = null
  changed.clear()
}
