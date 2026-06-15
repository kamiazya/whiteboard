import { describe, expect, it } from 'vitest'
// Import from the canonical location so coverage targets the implementation file,
// not the re-export shim.
import {
  buildWhiteboardWsProtocols,
  buildWhiteboardWsUrl,
} from '../../shared/ws-protocol.js'

describe('buildWhiteboardWsUrl', () => {
  it('preserves the current hostname and upgrades http to ws', () => {
    expect(
      buildWhiteboardWsUrl('http://127.0.0.1:3099/canvas/sess/slug', 'sess-1', 'nested/slug'),
    ).toBe('ws://127.0.0.1:3099/ws/sess-1/nested%2Fslug')
  })

  it('preserves https origins as wss', () => {
    expect(
      buildWhiteboardWsUrl('https://whiteboard.example.com/canvas/sess/slug', 'sess-1', 'slug'),
    ).toBe('wss://whiteboard.example.com/ws/sess-1/slug')
  })

  it('websocket protocol offer stays stable for daemon-authenticated browsers', () => {
    expect(buildWhiteboardWsProtocols('secret')).toEqual([
      'excalidraw-v1',
      'daemon-token.secret',
    ])
  })
})
