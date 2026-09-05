import type { IncomingHttpHeaders } from 'node:http'
import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  TICKET_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import { ALL_AUTH_SCOPES, type AuthScope } from '../security/auth-strategy.js'
import {
  isLoopbackHostname,
  normalizeHostHeader,
  normalizeOriginHostname,
} from '../security/cors-loopback.js'
import { timingSafeEqualStrings } from '../security/timing-safe.js'
import {
  type AllowedWebOrigins,
  isAllowedWebOrigin,
  resolveAllowedWebOrigins,
} from '../security/web-origin-allowlist.js'

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
  allowedOrigins: AllowedWebOrigins = [],
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
  // Any loopback Origin is admitted, mirroring the HTTP CORS policy
  // (createApiLoopbackCorsMiddleware). Loopback names (localhost /
  // 127.0.0.1 / ::1) all resolve to the same interface and a local page can
  // always target the daemon under its own loopback name, so requiring
  // originHost === requestHost never blocked a local attacker — it only
  // broke legitimate cross-name pairs (a localhost:5173 page against a
  // 127.0.0.1 daemon). The real guards are the loopback Host check above
  // (DNS rebinding) and the token check in authorizeWsUpgrade.
  const originHost = normalizeOriginHostname(originHeader)
  if (originHost !== null && isLoopbackHostname(originHost)) {
    return true
  }
  // A hosted pairing origin (e.g. https://kamiazya-whiteboard.pages.dev) is
  // never loopback — it is admitted only via an exact allowlist match.
  return isAllowedWebOrigin(originHeader, resolveAllowedWebOrigins(allowedOrigins))
}

export interface WsUpgradeDecision {
  accept: boolean
  statusCode?: number
  protocol?: string
  // Present only when `accept` is true. Local-daemon's single shared token
  // is the only credential this upgrade path issues today, and — matching
  // `createLocalTokenAuthStrategy`'s documented single-tenant concession —
  // it grants every scope. The field exists so the per-message enforcement
  // in `routes/ws.ts` has something real to check against now, and so a
  // future scoped credential (a server-mode connection ticket, per
  // ADR-0005) has a seam to plug a narrower grant into without changing the
  // enforcement call site.
  scopes?: readonly AuthScope[]
}

// Redeems a connection ticket minted by POST /api/ws-ticket (ADR-0005),
// returning the grant's own scopes on success. Injected rather than imported
// directly so this module stays agnostic of the concrete ws-ticket-store
// instance — the caller (http-server.ts) owns the one store shared with the
// route handler that mints tickets.
export type RedeemTicketFn = (ticket: string) => {
  scopes: readonly AuthScope[]
  clientId: string
} | null

export function authorizeWsUpgrade(
  headers: IncomingHttpHeaders,
  token?: string,
  allowedOrigins: AllowedWebOrigins = [],
  redeemTicket?: RedeemTicketFn,
  // Origin-scoped pairing session tokens: accepted through the same
  // daemon-token subprotocol carrier the paired web app already uses, but
  // only when the upgrade's own Origin header matches the origin the token
  // was minted for.
  pairingTokens?: { validate(token: string, origin: string): boolean },
): WsUpgradeDecision {
  if (!isAllowedBrowserOrigin(headers.origin, headers.host, allowedOrigins)) {
    return { accept: false, statusCode: 403 }
  }

  const protocols = parseProtocolHeader(headers['sec-websocket-protocol'])
  const offeredBaseProtocol = protocols.includes(WHITEBOARD_WS_PROTOCOL)

  // Checked ahead of the daemon-token branch: a ticket is a narrower,
  // single-use credential distinct from the shared daemon token, and an
  // offered ticket protocol entry must be redeemed (or rejected) on its own
  // terms even when a daemon token is also configured for this daemon.
  const offeredTicketProtocol = protocols.find((protocol) =>
    protocol.startsWith(TICKET_WS_PROTOCOL_PREFIX),
  )
  if (offeredTicketProtocol !== undefined) {
    // Redemption is single-use, so it must only be attempted once the
    // request is otherwise well-formed: a malformed request missing the base
    // protocol is rejected without ever touching the store, so a still-valid
    // ticket survives to be retried with a correctly-formed request.
    if (!offeredBaseProtocol) {
      return { accept: false, statusCode: 401 }
    }
    const rawTicket = offeredTicketProtocol.slice(TICKET_WS_PROTOCOL_PREFIX.length)
    const redeemed = redeemTicket?.(rawTicket) ?? null
    if (redeemed === null) {
      return { accept: false, statusCode: 401 }
    }
    // Never ALL_AUTH_SCOPES here: a ticket carries exactly the scopes its
    // originating OAuth grant held, which is the whole point of bridging
    // through a ticket rather than reusing the daemon-token's full-authority
    // path.
    return { accept: true, protocol: WHITEBOARD_WS_PROTOCOL, scopes: redeemed.scopes }
  }

  if (!token) {
    return {
      accept: true,
      protocol: offeredBaseProtocol ? WHITEBOARD_WS_PROTOCOL : undefined,
      scopes: ALL_AUTH_SCOPES,
    }
  }

  const offeredToken = protocols.find((protocol) =>
    protocol.startsWith(DAEMON_TOKEN_WS_PROTOCOL_PREFIX),
  )
  const expectedToken = `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${token}`
  if (!offeredBaseProtocol || offeredToken === undefined) {
    return { accept: false, statusCode: 401 }
  }
  if (timingSafeEqualStrings(offeredToken, expectedToken)) {
    return { accept: true, protocol: WHITEBOARD_WS_PROTOCOL, scopes: ALL_AUTH_SCOPES }
  }
  if (pairingTokens !== undefined && typeof headers.origin === 'string') {
    let origin: string | null = null
    try {
      origin = new URL(headers.origin).origin
    } catch {
      origin = null
    }
    const rawToken = offeredToken.slice(DAEMON_TOKEN_WS_PROTOCOL_PREFIX.length)
    if (origin !== null && pairingTokens.validate(rawToken, origin)) {
      return { accept: true, protocol: WHITEBOARD_WS_PROTOCOL, scopes: ALL_AUTH_SCOPES }
    }
  }
  return { accept: false, statusCode: 401 }
}
