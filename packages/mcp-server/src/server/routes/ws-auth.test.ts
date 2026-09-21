import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  TICKET_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import { describe, expect, it } from 'vitest'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import { createCredentialResolver } from '../security/credential-resolver.js'
import { createWsTicketStore } from '../security/ws-ticket-store.js'
import { authorizeWsUpgrade } from './ws-auth.js'

// authorizeWsUpgrade is the gate between an inbound WS upgrade and the
// in-process broadcaster. Each branch corresponds to a real attack surface
// (DNS rebinding, missing Sec-WebSocket-Protocol, wrong token), so each gets
// its own assertion. http-server.test.ts exercises the integration; this file
// pins down the unit-level contract.

describe('authorizeWsUpgrade', () => {
  it('rejects with 403 when the Host header is non-loopback (DNS rebinding guard)', async () => {
    const decision = await authorizeWsUpgrade(
      { host: 'evil.example.com:3099' },
      createCredentialResolver({}),
    )
    expect(decision).toEqual({ accept: false, statusCode: 403 })
  })

  it('rejects with 403 when Origin host disagrees with the loopback Host header', async () => {
    const decision = await authorizeWsUpgrade(
      {
        host: '127.0.0.1:3099',
        origin: 'http://attacker.test',
      },
      createCredentialResolver({}),
    )
    expect(decision).toEqual({ accept: false, statusCode: 403 })
  })

  it('accepts loopback Host with no Origin (curl / MCP daemon client) when no token is required', async () => {
    const decision = await authorizeWsUpgrade(
      { host: 'localhost:3099' },
      createCredentialResolver({}),
    )
    expect(decision.accept).toBe(true)
  })

  it('an accepted upgrade always carries a `scopes` grant for downstream per-message enforcement', async () => {
    // The daemon token grants every scope, and this pins that the grant is
    // PRESENT and explicit rather than an implicit "everything is allowed"
    // left for routes/ws.ts to assume. Which credentials produce a narrower
    // set is `credential-resolver.ts`'s business; this only asserts the field
    // is always there on an accepted upgrade.
    const decision = await authorizeWsUpgrade(
      { host: 'localhost:3099' },
      createCredentialResolver({ daemonToken: 'secret-token' }),
      [],
    )
    expect(decision.accept).toBe(false) // no protocol/token offered
    const acceptedDecision = await authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret-token`,
      },
      createCredentialResolver({ daemonToken: 'secret-token' }),
    )
    expect(acceptedDecision.accept).toBe(true)
    expect(acceptedDecision.scopes).toEqual(ALL_AUTH_SCOPES)
  })

  it('reports the negotiated subprotocol when the client offers it', async () => {
    const decision = await authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
      },
      createCredentialResolver({}),
    )
    expect(decision).toMatchObject({
      accept: true,
      protocol: WHITEBOARD_WS_PROTOCOL,
      scopes: ALL_AUTH_SCOPES,
    })
  })

  it('rejects with 401 when token auth is enabled and the protocol header is missing the matching token', async () => {
    const decision = await authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
      },
      createCredentialResolver({ daemonToken: 'secret' }),
    )
    expect(decision).toEqual({ accept: false, statusCode: 401 })
  })

  it('accepts when the protocol header carries the right token alongside the base protocol', async () => {
    const decision = await authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
      },
      createCredentialResolver({ daemonToken: 'secret' }),
    )
    expect(decision).toMatchObject({
      accept: true,
      protocol: WHITEBOARD_WS_PROTOCOL,
      scopes: ALL_AUTH_SCOPES,
    })
  })

  // The timing-safe comparison moved with the credential branch: it is now
  // `credential-resolver.test.ts`'s to assert, against the resolver rather
  // than against this surface. Kept as a pointer rather than deleted, because
  // "this file no longer checks that" is worth a reader knowing.

  it('rejects with 401 for a same-length but wrong offered token', async () => {
    const decision = await authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        // Same length as 'secret' — must still be rejected, not accepted by a
        // partial/prefix comparison bug.
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}wrongy`,
      },
      createCredentialResolver({ daemonToken: 'secret' }),
    )
    expect(decision).toEqual({ accept: false, statusCode: 401 })
  })

  it('rejects with 403 for a non-loopback Origin even with a valid token (Origin check precedes token check)', async () => {
    const decision = await authorizeWsUpgrade(
      {
        host: '127.0.0.1:3099',
        origin: 'https://evil.example',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
      },
      createCredentialResolver({ daemonToken: 'secret' }),
    )
    expect(decision).toEqual({ accept: false, statusCode: 403 })
  })

  it('rejects with 401 when the offered token does not match', async () => {
    const decision = await authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}wrong`,
      },
      createCredentialResolver({ daemonToken: 'secret' }),
    )
    expect(decision).toEqual({ accept: false, statusCode: 401 })
  })

  it('accepts a bracketed IPv6 loopback Origin against a bracketed IPv6 loopback Host', async () => {
    // Node's URL parser keeps the brackets in .hostname for IPv6 ("[::1]"),
    // while the Host header side is normalized to bare "::1" — both sides
    // must agree once stripped, or real IPv6 loopback dev setups get a 403.
    const decision = await authorizeWsUpgrade(
      {
        host: '[::1]:3099',
        origin: 'http://[::1]:5173',
      },
      createCredentialResolver({}),
    )
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
    it('admits a localhost Origin against a 127.0.0.1 Host without an allowlist entry', async () => {
      const decision = await authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'http://localhost:5173' },
        createCredentialResolver({}),
        [],
      )
      expect(decision.accept).toBe(true)
    })

    it('still requires the token for a cross-name loopback Origin when token auth is on', async () => {
      const decision = await authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'http://localhost:5173' },
        createCredentialResolver({ daemonToken: 'secret-token' }),
        [],
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('admits a cross-name loopback Origin offering the correct token', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'http://localhost:5173',
          'sec-websocket-protocol': 'whiteboard-v1, daemon-token.secret-token',
        },
        createCredentialResolver({ daemonToken: 'secret-token' }),
        [],
      )
      expect(decision.accept).toBe(true)
    })
  })

  describe('hosted-origin allowlist admission', () => {
    const allowedOrigins = ['https://kamiazya-whiteboard.pages.dev']

    it('admits an exact allowlisted hosted origin against a loopback Host', async () => {
      const decision = await authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://kamiazya-whiteboard.pages.dev' },
        createCredentialResolver({}),
        allowedOrigins,
      )
      expect(decision.accept).toBe(true)
    })

    it('still rejects a non-loopback Host even for an allowlisted origin (DNS-rebinding guard)', async () => {
      const decision = await authorizeWsUpgrade(
        { host: 'evil.example.com:3099', origin: 'https://kamiazya-whiteboard.pages.dev' },
        createCredentialResolver({}),
        allowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })

    it('rejects a lookalike origin not present in the allowlist', async () => {
      const decision = await authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://evil-kamiazya-whiteboard.pages.dev' },
        createCredentialResolver({}),
        allowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })

    it('401s an allowlisted origin without the required token', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'https://kamiazya-whiteboard.pages.dev',
          'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
        },
        createCredentialResolver({ daemonToken: 'secret' }),
        allowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })
  })

  describe('wildcard subdomain allowlist admission', () => {
    const wildcardAllowedOrigins = ['https://*.kamiazya-whiteboard.pages.dev']

    it('admits an Origin matched by a wildcard pattern with a valid token', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'https://preview-42.kamiazya-whiteboard.pages.dev',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
        },
        createCredentialResolver({ daemonToken: 'secret' }),
        wildcardAllowedOrigins,
      )
      expect(decision.accept).toBe(true)
    })

    it('still 403s a non-matching origin', async () => {
      const decision = await authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://evil.com' },
        createCredentialResolver({}),
        wildcardAllowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })

    it('403s a two-label subdomain — only one label is matched', async () => {
      const decision = await authorizeWsUpgrade(
        { host: '127.0.0.1:3099', origin: 'https://a.b.kamiazya-whiteboard.pages.dev' },
        createCredentialResolver({}),
        wildcardAllowedOrigins,
      )
      expect(decision).toEqual({ accept: false, statusCode: 403 })
    })
  })

  describe('ADR-0005 connection ticket', () => {
    it('redeems an offered ticket and returns exactly the redeemed scopes, never ALL_AUTH_SCOPES', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}abc123`,
        },
        createCredentialResolver({
          daemonToken: 'daemon-token-irrelevant-here',
          redeemTicket: (ticket) =>
            ticket === 'abc123' ? { scopes: ['canvas:read'], clientId: 'client-a' } : null,
        }),
        [],
      )
      expect(decision).toMatchObject({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ['canvas:read'],
      })
    })

    it('rejects with 401 when redeemTicket reports the ticket as unknown/expired/replayed', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}spent`,
        },
        createCredentialResolver({ redeemTicket: () => null }),
        [],
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('rejects with 401 when no redeemTicket dependency is wired even though a ticket was offered', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}abc123`,
        },
        createCredentialResolver({}),
        [],
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('preserves the daemon-token path exactly: still returns ALL_AUTH_SCOPES when no ticket is offered', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
        },
        createCredentialResolver({ daemonToken: 'secret', redeemTicket: () => null }),
        [],
      )
      expect(decision).toMatchObject({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ALL_AUTH_SCOPES,
      })
    })

    it('preserves the no-auth-required path: still returns ALL_AUTH_SCOPES when no token is configured', async () => {
      const decision = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
        },
        createCredentialResolver({}),
      )
      expect(decision).toMatchObject({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ALL_AUTH_SCOPES,
      })
    })

    it('does not accept a raw OAuth access token offered directly in the subprotocol (no ticket prefix)', async () => {
      // A hosted-origin caller must go through POST /api/ws-ticket first —
      // offering the bearer itself, unprefixed, must fail exactly like any
      // other unrecognized protocol entry.
      const decision = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, oauth-access-token-raw-value`,
        },
        createCredentialResolver({
          daemonToken: 'daemon-secret',
          redeemTicket: () => ({ scopes: ALL_AUTH_SCOPES, clientId: 'should-not-be-reached' }),
        }),
        [],
      )
      expect(decision).toEqual({ accept: false, statusCode: 401 })
    })

    it('round-trips through a real ws-ticket-store: mint, then redeem exactly once via authorizeWsUpgrade', async () => {
      const ticketStore = createWsTicketStore()
      const { ticket } = ticketStore.mintTicket(['canvas:write'], 'client-a')

      const first = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        createCredentialResolver({ redeemTicket: ticketStore.redeemTicket }),
        [],
      )
      expect(first).toMatchObject({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ['canvas:write'],
      })

      const replay = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        createCredentialResolver({ redeemTicket: ticketStore.redeemTicket }),
        [],
      )
      expect(replay).toEqual({ accept: false, statusCode: 401 })
    })

    it('does not redeem the ticket when the base protocol is missing, so the ticket stays usable for a valid retry', async () => {
      const ticketStore = createWsTicketStore()
      const { ticket } = ticketStore.mintTicket(['canvas:write'], 'client-a')

      const malformed = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          // Base protocol (WHITEBOARD_WS_PROTOCOL) omitted, ticket only.
          'sec-websocket-protocol': `${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        createCredentialResolver({ redeemTicket: ticketStore.redeemTicket }),
        [],
      )
      expect(malformed).toEqual({ accept: false, statusCode: 401 })

      const retry = await authorizeWsUpgrade(
        {
          host: 'localhost:3099',
          'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${TICKET_WS_PROTOCOL_PREFIX}${ticket}`,
        },
        createCredentialResolver({ redeemTicket: ticketStore.redeemTicket }),
        [],
      )
      expect(retry).toMatchObject({
        accept: true,
        protocol: WHITEBOARD_WS_PROTOCOL,
        scopes: ['canvas:write'],
      })
    })
  })
})
