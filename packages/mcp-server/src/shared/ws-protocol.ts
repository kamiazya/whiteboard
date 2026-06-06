export const WHITEBOARD_WS_PROTOCOL = 'excalidraw-v1'
export const DAEMON_TOKEN_WS_PROTOCOL_PREFIX = 'daemon-token.'

export function buildWhiteboardWsProtocols(
  daemonToken?: string | null,
): string[] {
  if (!daemonToken) {
    return [WHITEBOARD_WS_PROTOCOL]
  }
  return [
    WHITEBOARD_WS_PROTOCOL,
    `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${daemonToken}`,
  ]
}

export function buildWhiteboardWsUrl(
  locationHref: string,
  workspaceId: string,
  slug: string,
): string {
  const url = new URL(locationHref)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/${workspaceId}/${encodeURIComponent(slug)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}
