export const WHITEBOARD_WS_PROTOCOL = 'excalidraw-v1'
export const DAEMON_TOKEN_WS_PROTOCOL_PREFIX = 'daemon-token.'
// ADR-0005: a hosted-origin caller authorizes a WS upgrade with a short-lived,
// single-use connection ticket (minted via POST /api/ws-ticket) rather than
// its long-lived OAuth access token — the token itself never travels in
// Sec-WebSocket-Protocol.
export const TICKET_WS_PROTOCOL_PREFIX = 'whiteboard-ticket.'

export function buildWhiteboardWsProtocols(daemonToken?: string | null): string[] {
  if (!daemonToken) {
    return [WHITEBOARD_WS_PROTOCOL]
  }
  return [WHITEBOARD_WS_PROTOCOL, `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${daemonToken}`]
}

// Client-side counterpart for a hosted-origin caller holding an OAuth grant:
// offers the connection ticket instead of a daemon token.
export function buildWhiteboardWsProtocolsWithTicket(ticket: string): string[] {
  return [WHITEBOARD_WS_PROTOCOL, `${TICKET_WS_PROTOCOL_PREFIX}${ticket}`]
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
