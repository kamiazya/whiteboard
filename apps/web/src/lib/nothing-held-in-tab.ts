import { isNotKeeping } from './connection-state.js'
import { getShellConnection } from './shell-status-store.js'

/**
 * Whether reloading this tab unasked would cost nothing. While the keeper is
 * not keeping (`isNotKeeping`), what was typed exists in this tab alone, so a
 * reload nobody requested, such as taking a waiting update, must not happen
 * then. A browser edit that is merely stuck still asks before the tab goes
 * (`asksForReturn`) but does not hold the reload: the stuck panel's own way
 * out is reloading the page, so a reload is not what loses that edit.
 */
export function nothingHeldInTab(): boolean {
  const connection = getShellConnection()
  return connection === null || !isNotKeeping(connection.state)
}
