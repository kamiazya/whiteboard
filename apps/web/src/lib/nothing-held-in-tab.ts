import { isNotKeeping } from './connection-state.js'
import { getShellConnection } from './shell-status-store.js'

/**
 * Whether reloading this tab unasked would cost nothing. While the keeper is
 * not keeping, what was typed exists in this tab alone — the state in which
 * the page itself asks before the tab goes — so a reload nobody requested,
 * such as taking a waiting update, must not happen then.
 */
export function nothingHeldInTab(): boolean {
  const connection = getShellConnection()
  return connection === null || !isNotKeeping(connection.state)
}
