import type { IncomingHttpHeaders } from 'node:http'
import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '../../shared/ws-protocol.js'

function parseProtocolHeader(header: string | string[] | undefined): string[] {
  if (Array.isArray(header)) {
    return header.flatMap((value) => parseProtocolHeader(value))
  }
  if (!header) return []
  return header
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function normalizeHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  try {
    return new URL(`http://${hostHeader}`).hostname
  } catch {
    return null
  }
}

function isAllowedBrowserOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
): boolean {
  // Requests without Origin (curl, ws CLI, MCP daemon clients, etc.) are treated as
  // non-browser callers and are allowed, but DNS rebinding protection still requires
  // the Host header to be loopback (localhost / 127.0.0.1 / ::1). Otherwise an attacker
  // domain could still reach 127.0.0.1 through rebinding.
  const requestHost = normalizeHostHeader(hostHeader)
  if (!requestHost) return false
  if (!isLoopbackHostname(requestHost)) return false
  if (!originHeader) return true
  try {
    const origin = new URL(originHeader)
    return isLoopbackHostname(origin.hostname) && origin.hostname === requestHost
  } catch {
    return false
  }
}

export interface WsUpgradeDecision {
  accept: boolean
  statusCode?: number
  protocol?: string
}

export function authorizeWsUpgrade(
  headers: IncomingHttpHeaders,
  token?: string,
): WsUpgradeDecision {
  if (!isAllowedBrowserOrigin(headers.origin, headers.host)) {
    return { accept: false, statusCode: 403 }
  }

  const protocols = parseProtocolHeader(headers['sec-websocket-protocol'])
  const offeredBaseProtocol = protocols.includes(WHITEBOARD_WS_PROTOCOL)

  if (!token) {
    return {
      accept: true,
      protocol: offeredBaseProtocol ? WHITEBOARD_WS_PROTOCOL : undefined,
    }
  }

  const offeredToken = protocols.find((protocol) =>
    protocol.startsWith(DAEMON_TOKEN_WS_PROTOCOL_PREFIX),
  )
  if (
    !offeredBaseProtocol ||
    offeredToken !== `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${token}`
  ) {
    return { accept: false, statusCode: 401 }
  }

  return { accept: true, protocol: WHITEBOARD_WS_PROTOCOL }
}
