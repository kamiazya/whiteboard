import type { IncomingHttpHeaders } from 'node:http'
import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  TICKET_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import type { AuthScope } from '../security/auth-strategy.js'
import {
  isLoopbackHostname,
  normalizeHostHeader,
  normalizeOriginHostname,
} from '../security/cors-loopback.js'
import type { CredentialResolver } from '../security/credential-resolver.js'
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
  // Present only when `accept` is true, and it is what the socket may do:
  // `routes/ws.ts` checks it per operation against `ws-scope-registry.ts`.
  // Which credentials can produce a NARROWER set than the full one is the
  // resolver's business, not this file's.
  scopes?: readonly AuthScope[]
}

/**
 * Who may open this socket, and with what.
 *
 * The credential branches live in `security/credential-resolver.ts`; what is
 * here is this surface's own three things — the carrier (a
 * `Sec-WebSocket-Protocol` entry rather than a header), the policy (NONE at
 * the handshake, because `routes/ws.ts` enforces per operation downstream
 * against `ws-scope-registry.ts`), and the refusal shape (a status code on a
 * decision object, not a response).
 *
 * The resolver is a REQUIRED argument. It used to be five optional ones, and
 * dropping `macaroonRootKey` from the call site left all eleven macaroon tests
 * green because each supplied its own key — the defect that motivated the
 * whole refactor.
 */
export async function authorizeWsUpgrade(
  headers: IncomingHttpHeaders,
  resolver: CredentialResolver,
  allowedOrigins: AllowedWebOrigins = [],
): Promise<WsUpgradeDecision> {
  if (!isAllowedBrowserOrigin(headers.origin, headers.host, allowedOrigins)) {
    return { accept: false, statusCode: 403 }
  }

  const protocols = parseProtocolHeader(headers['sec-websocket-protocol'])
  const offeredBaseProtocol = protocols.includes(WHITEBOARD_WS_PROTOCOL)
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined

  // Checked ahead of everything else: a ticket is a narrower, single-use
  // credential distinct from the shared daemon token, and an offered ticket
  // must be redeemed (or rejected) on its own terms even when a daemon token
  // is also configured.
  const offeredTicketProtocol = protocols.find((protocol) =>
    protocol.startsWith(TICKET_WS_PROTOCOL_PREFIX),
  )
  if (offeredTicketProtocol !== undefined) {
    // Redemption is single-use, so it must only be attempted once the request
    // is otherwise well-formed: a malformed request missing the base protocol
    // is rejected without ever touching the store, so a still-valid ticket
    // survives to be retried with a correctly-formed request.
    if (!offeredBaseProtocol) {
      return { accept: false, statusCode: 401 }
    }
    const grant = await resolver.resolve({
      secret: offeredTicketProtocol.slice(TICKET_WS_PROTOCOL_PREFIX.length),
      carrier: 'ws-ticket',
      origin,
    })
    if (grant === null) {
      return { accept: false, statusCode: 401 }
    }
    // Never the full set here: a ticket carries exactly the scopes its
    // originating OAuth grant held, which is the whole point of bridging
    // through a ticket rather than reusing the daemon token's path.
    return { accept: true, protocol: WHITEBOARD_WS_PROTOCOL, scopes: grant.scopes }
  }

  const offeredToken = protocols.find((protocol) =>
    protocol.startsWith(DAEMON_TOKEN_WS_PROTOCOL_PREFIX),
  )
  const grant = await resolver.resolve({
    secret:
      offeredToken === undefined
        ? null
        : offeredToken.slice(DAEMON_TOKEN_WS_PROTOCOL_PREFIX.length),
    carrier: 'ws-subprotocol',
    origin,
  })

  // A daemon with no token configured accepts the upgrade whether or not the
  // base protocol was offered — the one place this surface answers without
  // one, and it predates the resolver.
  if (grant?.kind === 'anonymous') {
    return {
      accept: true,
      protocol: offeredBaseProtocol ? WHITEBOARD_WS_PROTOCOL : undefined,
      scopes: grant.scopes,
    }
  }
  if (!offeredBaseProtocol || offeredToken === undefined) {
    return { accept: false, statusCode: 401 }
  }
  if (grant === null) {
    return { accept: false, statusCode: 401 }
  }
  // `routes/ws.ts` runs `hasRequiredScopes` on every text message and every
  // binary update, so a narrower array here really narrows what the socket can
  // do rather than being a value nobody reads.
  return { accept: true, protocol: WHITEBOARD_WS_PROTOCOL, scopes: grant.scopes }
}
