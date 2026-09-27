/**
 * How a daemon reached through the whiteboard extension (ADR-0050) is named,
 * kept apart from the bridge itself so the pages that only ask "is this the
 * bridge?" load none of it: the bridge and its schemas arrive on first use.
 */

/**
 * The address the app gives a daemon reached through the extension. `.invalid`
 * is reserved (RFC 2606), so nothing on a network can ever answer it — every
 * request to it goes through the bridge or nowhere.
 */
export const BRIDGE_DAEMON_BASE_URL = 'https://daemon.whiteboard.invalid'

export const BRIDGE_ORIGIN = new URL(BRIDGE_DAEMON_BASE_URL).origin

export function isBridgeDaemon(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === BRIDGE_ORIGIN
  } catch {
    return false
  }
}
