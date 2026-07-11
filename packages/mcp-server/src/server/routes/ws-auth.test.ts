import { describe, expect, it } from 'vitest'
import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '../../shared/ws-protocol.js'
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

  it('reports the negotiated subprotocol when the client offers it', () => {
    const decision = authorizeWsUpgrade({
      host: 'localhost:3099',
      'sec-websocket-protocol': WHITEBOARD_WS_PROTOCOL,
    })
    expect(decision).toEqual({ accept: true, protocol: WHITEBOARD_WS_PROTOCOL })
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
    expect(decision).toEqual({ accept: true, protocol: WHITEBOARD_WS_PROTOCOL })
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
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.secret-token',
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
})
