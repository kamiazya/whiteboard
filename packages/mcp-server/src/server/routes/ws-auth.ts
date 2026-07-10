import type { IncomingHttpHeaders } from 'node:http'
import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '../../shared/ws-protocol.js'
import {
  isLoopbackHostname,
  normalizeHostHeader,
  normalizeOriginHostname,
} from '../security/cors-loopback.js'
import { isAllowedWebOrigin } from '../security/web-origin-allowlist.js'

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

function isAllowedBrowserOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  // Requests without Origin (curl, ws CLI, MCP daemon clients, etc.) are treated as
  // non-browser callers and are allowed, but DNS rebinding protection still requires
  // the Host header to be loopback (localhost / 127.0.0.1 / ::1). Otherwise an attacker
  // domain could still reach 127.0.0.1 through rebinding. This Host check is unchanged
  // by the allowedOrigins allowlist below — only the Origin branch widens.
  const requestHost = normalizeHostHeader(hostHeader)
  if (!requestHost) return false
  if (!isLoopbackHostname(requestHost)) return false
  if (!originHeader) return true
  // Use the shared normalizer (strips IPv6 brackets) so this side agrees
  // with normalizeHostHeader above — otherwise http://[::1] never matches
  // a Host header normalized to bare "::1".
  const originHost = normalizeOriginHostname(originHeader)
  if (originHost !== null && isLoopbackHostname(originHost) && originHost === requestHost) {
    return true
  }
  // A hosted pairing origin (e.g. https://kamiazya-whiteboard.pages.dev) is
  // never loopback, so it cannot satisfy originHost === requestHost above —
  // it is admitted only via an exact allowlist match instead.
  return isAllowedWebOrigin(originHeader, allowedOrigins)
}

export interface WsUpgradeDecision {
  accept: boolean
  statusCode?: number
  protocol?: string
}

export function authorizeWsUpgrade(
  headers: IncomingHttpHeaders,
  token?: string,
  allowedOrigins: readonly string[] = [],
): WsUpgradeDecision {
  if (!isAllowedBrowserOrigin(headers.origin, headers.host, allowedOrigins)) {
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
  if (!offeredBaseProtocol || offeredToken !== `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${token}`) {
    return { accept: false, statusCode: 401 }
  }

  return { accept: true, protocol: WHITEBOARD_WS_PROTOCOL }
}
