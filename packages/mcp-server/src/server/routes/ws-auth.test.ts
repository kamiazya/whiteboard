import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  TICKET_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import { describe, expect, it, vi } from 'vitest'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import * as timingSafe from '../security/timing-safe.js'
import { createWsTicketStore } from '../security/ws-ticket-store.js'
import { authorizeWsUpgrade } from './ws-auth.js'

// authorizeWsUpgrade is the gate between an inbound WS upgrade and the
// in-process broadcaster. Each branch corresponds to a real attack surface
// (DNS rebinding, missing Sec-WebSocket-Protocol, wrong token), so each gets
// its own assertion. http-server.test.ts exercises the integration; this file
// pins down the unit-level contract.

describe('authorizeWsUpgrade', () => {
  it('rejects with 403 when the Host header is non-loopback (DNS rebinding guard)', () => {
    const decision = authorizeWsUpgrade({ host: 'evil.example.com:3099' })
    expect(decision).toEqual({ accept: false, statusCode: 403 })
  })

  it('rejects with 403 when Origin host disagrees with the loopback Host header', () => {
    const decision = authorizeWsUpgrade({
      host: '127.0.0.1:3099',
      origin: 'http://attacker.test',
    })
    expect(decision).toEqual({ accept: false, statusCode: 403 })
  })

  it('accepts loopback Host with no Origin (curl / MCP daemon client) when no token is required', () => {
    const decision = authorizeWsUpgrade({ host: 'localhost:3099' })
    expect(decision.accept).toBe(true)
  })

  it('an accepted upgrade always carries a `scopes` grant for downstream per-message enforcement', () => {
    // Today's only WS credential is the single shared daemon token, which —
    // matching createLocalTokenAuthStrategy's documented single-tenant
    // concession — grants every scope. This pins that the grant is present
    // and explicit, not an implicit "everything is allowed" left for
    // routes/ws.ts to assume.
    const decision = authorizeWsUpgrade({ host: 'localhost:3099' }, 'secret-token', [])
    expect(decision.accept).toBe(false) // no protocol/token offered
    const acceptedDecision = authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret-token`,
      },
      'secret-token',
    )
    expect(acceptedDecision.accept).toBe(true)
    expect(acceptedDecision.scopes).toEqual(ALL_AUTH_SCOPES)
  })

  it('reports the negotiated subprotocol when the client offers it', () => {
    const decision = authorizeWsUpgrade({
      host: 'localhost:3099',
      'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
    })
    expect(decision).toEqual({
      accept: true,
      protocol: WHITEBOARD_WS_PROTOCOL,
      scopes: ALL_AUTH_SCOPES,
    })
  })

  it('rejects with 401 when token auth is enabled and the protocol header is missing the matching token', () => {
    const decision = authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
      },
      'secret',
    )
    expect(decision).toEqual({ accept: false, statusCode: 401 })
  })

  it('accepts when the protocol header carries the right token alongside the base protocol', () => {
    const decision = authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
      },
      'secret',
    )
    expect(decision).toEqual({
      accept: true,
      protocol: WHITEBOARD_WS_PROTOCOL,
      scopes: ALL_AUTH_SCOPES,
    })
  })

  it('compares the offered daemon token through the shared timing-safe helper, not a plain !==', () => {
    const spy = vi.spyOn(timingSafe, 'timingSafeEqualStrings')
    try {
      authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
        },
        'secret',
      )
      expect(spy).toHaveBeenCalledWith(
        `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
        `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects with 401 for a same-length but wrong offered token', () => {
    const decision = authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        // Same length as 'secret' — must still be rejected, not accepted by a
        // partial/prefix comparison bug.
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}wrongy`,
      },
      'secret',
    )
    expect(decision).toEqual({ accept: false, statusCode: 401 })
  })

  it('rejects with 403 for a non-loopback Origin even with a valid token (Origin check precedes token check)', () => {
    const decision = authorizeWsUpgrade(
      {
        host: '127.0.0.1:3099',
        origin: 'https://evil.example',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
      },
      'secret',
    )
    expect(decision).toEqual({ accept: false, statusCode: 403 })
  })

  it('rejects with 401 when the offered token does not match', () => {
    const decision = authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}wrong`,
      },
      'secret',
    )
    expect(decision).toEqual({ accept: false, statusCode: 401 })
  })

  it('accepts a bracketed IPv6 loopback Origin against a bracketed IPv6 loopback Host', () => {
    // Node's URL parser keeps the brackets in .hostname for IPv6 ("[::1]"),
    // while the Host header side is normalized to bare "::1" — both sides
    // must agree once stripped, or real IPv6 loopback dev setups get a 403.
    const decision = authorizeWsUpgrade({
      host: '[::1]:3099',
      origin: 'http://[::1]:5173',
    })
    expect(decision.accept).toBe(true)
  })

  describe('cross-name loopback Origin admission (parity with the HTTP CORS policy)', () => {
    // Loopback names (localhost / 127.0.0.1 / ::1) all resolve to the same
    // interface, and any local page can trivially target the daemon under
    // its own loopback name — so requiring originHost === requestHost never
    // blocked a local attacker, it only broke legitimate cross-name pairs
    // (a localhost:5173 page pairing with a 127.0.0.1 daemon). The policy is
    // therefore loopback-OR-allowlist, identical to the HTTP CORS middleware;
    // the real guards remain the loopback Host check (DNS rebinding) and the
    // token requirement below.
    it('admits a localhost Origin against a 127.0.0.1 Host without an allowlist entry', () => {
      const decision = authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'http://localhost:5173' },
        undefined,
        [],
      )
      expect(decision.accept).toBe(true)
    })

    it('still requires the token for a cross-name loopback Origin when token auth is on', () => {
      const decision = authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'http://localhost:5173' },
        'secret-token',
        [],
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('admits a cross-name loopback Origin offering the correct token', () => {
      const decision = authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'http://localhost:5173',
          'sec-websocket-protocol': 'whiteboard-v1, daemon-token.secret-token',
        },
        'secret-token',
        [],
      )
      expect(decision.accept).toBe(true)
    })
  })

  describe('hosted-origin allowlist admission', () => {
    const allowedOrigins = ['https://kamiazya-whiteboard.pages.dev']

    it('admits an exact allowlisted hosted origin against a loopback Host', () => {
      const decision = authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://kamiazya-whiteboard.pages.dev' },
        undefined,
        allowedOrigins,
      )
      expect(decision.accept).toBe(true)
    })

    it('still rejects a non-loopback Host even for an allowlisted origin (DNS-rebinding guard)', () => {
      const decision = authorizeWsUpgrade(
        { host: 'evil.example.com:3099', origin: 'https://kamiazya-whiteboard.pages.dev' },
        undefined,
        allowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })

    it('rejects a lookalike origin not present in the allowlist', () => {
      const decision = authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://evil-kamiazya-whiteboard.pages.dev' },
        undefined,
        allowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })

    it('401s an allowlisted origin without the required token', () => {
      const decision = authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'https://kamiazya-whiteboard.pages.dev',
          'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
        },
        'secret',
        allowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })
  })

  describe('wildcard subdomain allowlist admission', () => {
    const wildcardAllowedOrigins = ['https://*.kamiazya-whiteboard.pages.dev']

    it('admits an Origin matched by a wildcard pattern with a valid token', () => {
      const decision = authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'https://preview-42.kamiazya-whiteboard.pages.dev',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
        },
        'secret',
        wildcardAllowedOrigins,
      )
      expect(decision.accept).toBe(true)
    })

    it('still 403s a non-matching origin', () => {
      const decision = authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://evil.com' },
        undefined,
        wildcardAllowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })

    it('403s a two-label subdomain — only one label is matched', () => {
      const decision = authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://a.b.kamiazya-whiteboard.pages.dev' },
        undefined,
        wildcardAllowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })
  })

  describe('ADR-0005 connection ticket', () => {
    it('redeems an offered ticket and returns exactly the redeemed scopes, never ALL_AUTH_SCOPES', () => {
      const decision = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}abc123`,
        },
        'daemon-token-irrelevant-here',
        [],
        (ticket) =>
          ticket === 'abc123' ? { scopes: ['canvas:read'], clientId: 'client-a' } : null,
      )
      expect(decision).toEqual({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ['canvas:read'],
      })
    })

    it('rejects with 401 when redeemTicket reports the ticket as unknown/expired/replayed', () => {
      const decision = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}spent`,
        },
        undefined,
        [],
        () => null,
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('rejects with 401 when no redeemTicket dependency is wired even though a ticket was offered', () => {
      const decision = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}abc123`,
        },
        undefined,
        [],
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('preserves the daemon-token path exactly: still returns ALL_AUTH_SCOPES when no ticket is offered', () => {
      const decision = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
        },
        'secret',
        [],
        () => null,
      )
      expect(decision).toEqual({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ALL_AUTH_SCOPES,
      })
    })

    it('preserves the no-auth-required path: still returns ALL_AUTH_SCOPES when no token is configured', () => {
      const decision = authorizeWsUpgrade({
        host: 'localhost:3099',
        'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
      })
      expect(decision).toEqual({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ALL_AUTH_SCOPES,
      })
    })

    it('does not accept a raw OAuth access token offered directly in the subprotocol (no ticket prefix)', () => {
      // A hosted-origin caller must go through POST /api/ws-ticket first —
      // offering the bearer itself, unprefixed, must fail exactly like any
      // other unrecognized protocol entry.
      const decision = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, oauth-access-token-raw-value`,
        },
        'daemon-secret',
        [],
        () => ({ scopes: ALL_AUTH_SCOPES, clientId: 'should-not-be-reached' }),
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('round-trips through a real ws-ticket-store: mint, then redeem exactly once via authorizeWsUpgrade', () => {
      const ticketStore = createWsTicketStore()
      const { ticket } = ticketStore.mintTicket(['canvas:write'], 'client-a')

      const first = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        undefined,
        [],
        ticketStore.redeemTicket,
      )
      expect(first).toEqual({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ['canvas:write'],
      })

      const replay = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        undefined,
        [],
        ticketStore.redeemTicket,
      )
      expect(replay).toEqual({ accept: false, statusCode: 401 })
    })

    it('does not redeem the ticket when the base protocol is missing, so the ticket stays usable for a valid retry', () => {
      const ticketStore = createWsTicketStore()
      const { ticket } = ticketStore.mintTicket(['canvas:write'], 'client-a')

      const malformed = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          // Base protocol (WHITEBOARD_WS_PROTOCOL) omitted, ticket only.
          'sec-websocket-protocol': `${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        undefined,
        [],
        ticketStore.redeemTicket,
      )
      expect(malformed).toEqual({ accept: false, statusCode: 401 })

      const retry = authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        undefined,
        [],
        ticketStore.redeemTicket,
      )
      expect(retry).toEqual({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ['canvas:write'],
      })
    })
  })
})
