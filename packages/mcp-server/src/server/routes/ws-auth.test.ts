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
})
