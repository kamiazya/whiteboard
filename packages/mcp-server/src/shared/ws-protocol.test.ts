import { describe, expect, it } from 'vitest'
import {
  buildWhiteboardWsProtocols,
  buildWhiteboardWsProtocolsWithTicket,
  buildWhiteboardWsUrl,
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  TICKET_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from './ws-protocol.js'

describe('buildWhiteboardWsProtocols', () => {
  it('offers only the base protocol when no daemon token is configured', () => {
    expect(buildWhiteboardWsProtocols()).toEqual([WHITEBOARD_WS_PROTOCOL])
  })

  it('offers the base protocol plus the daemon-token entry when a token is configured', () => {
    expect(buildWhiteboardWsProtocols('secret')).toEqual([
      WHITEBOARD_WS_PROTOCOL,
      `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}secret`,
    ])
  })
})

describe('buildWhiteboardWsProtocolsWithTicket', () => {
  it('offers the base protocol plus the ticket entry, mirroring authorizeWsUpgrade’s expected shape', () => {
    // ws-auth.ts's authorizeWsUpgrade requires exactly this pairing: the base
    // protocol present alongside a whiteboard-ticket.-prefixed entry (ADR-0005).
    expect(buildWhiteboardWsProtocolsWithTicket('abc123')).toEqual([
      WHITEBOARD_WS_PROTOCOL,
      `${TICKET_WS_PROTOCOL_PREFIX}abc123`,
    ])
  })
})

describe('buildWhiteboardWsUrl', () => {
  it('rewrites http(s) to ws(s) and points the path at the workspace/slug WS route', () => {
    expect(buildWhiteboardWsUrl('https://example.com/app', 'ws1', 'main')).toBe(
      'wss://example.com/ws/ws1/main',
    )
    expect(buildWhiteboardWsUrl('http://localhost:5173/', 'ws1', 'main')).toBe(
      'ws://localhost:5173/ws/ws1/main',
    )
  })

  it('encodes the slug and strips any existing search/hash', () => {
    expect(buildWhiteboardWsUrl('https://example.com/app?x=1#frag', 'ws1', 'my slug')).toBe(
      'wss://example.com/ws/ws1/my%20slug',
    )
  })
})
