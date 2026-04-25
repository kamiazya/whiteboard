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
