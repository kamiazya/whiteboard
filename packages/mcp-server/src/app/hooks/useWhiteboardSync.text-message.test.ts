import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VersionCreatedPayload } from '../../shared/ws-messages.js'
import { parseServerTextMessage } from './useWhiteboardSync.text-message.js'

function makeVersion(): VersionCreatedPayload {
  return {
    id: 'ver-1',
    slug: 'canvas-a',
    createdAt: '2026-04-23T00:00:00.000Z',
    elementCount: 3,
    auto: true,
    hasThumbnail: false,
  }
}

describe('parseServerTextMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns warn + null instead of throwing on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseServerTextMessage('{not-json')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('treats non-objects and unknown types as no-ops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseServerTextMessage('"hello"')).toBeNull()
    expect(parseServerTextMessage('{"type":"unknown"}')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('treats version_created with missing required fields as a no-op', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseServerTextMessage('{"type":"version_created"}')).toBeNull()
    expect(
      parseServerTextMessage(
        JSON.stringify({
          type: 'version_created',
          version: { slug: 'canvas-a' },
        }),
      ),
    ).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('treats viewport_request/export_request without requestId as a no-op', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseServerTextMessage('{"type":"viewport_request"}')).toBeNull()
    expect(parseServerTextMessage('{"type":"export_request"}')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('returns structured data for valid allowlisted messages', () => {
    expect(
      parseServerTextMessage(
        JSON.stringify({
          type: 'version_created',
          version: {
            ...makeVersion(),
            operator: {
              kind: 'system',
              peerId: 'peer-1',
              displayName: 'auto-save',
            },
          },
        }),
      ),
    ).toEqual({
      type: 'version_created',
      version: {
        ...makeVersion(),
        operator: {
          kind: 'system',
          peerId: 'peer-1',
          displayName: 'auto-save',
        },
      },
    })

    expect(
      parseServerTextMessage(
        JSON.stringify({
          type: 'viewport_request',
          requestId: 'req-1',
          mode: 'fit',
          elementIds: ['a', 'b'],
          animate: false,
        }),
      ),
    ).toEqual({
      type: 'viewport_request',
      requestId: 'req-1',
      mode: 'fit',
      elementIds: ['a', 'b'],
      animate: false,
    })

    expect(
      parseServerTextMessage(
        JSON.stringify({
          type: 'export_request',
          requestId: 'req-2',
          minFontPx: 14,
          frameId: 'frame-1',
        }),
      ),
    ).toEqual({
      type: 'export_request',
      requestId: 'req-2',
      minFontPx: 14,
      frameId: 'frame-1',
    })
  })

  it('parses head_changed with a valid head string', () => {
    expect(
      parseServerTextMessage(JSON.stringify({ type: 'head_changed', head: 'feature-x' })),
    ).toEqual({ type: 'head_changed', head: 'feature-x' })
  })

  it('rejects head_changed without a head string', () => {
    expect(parseServerTextMessage(JSON.stringify({ type: 'head_changed' }))).toBeNull()
    expect(parseServerTextMessage(JSON.stringify({ type: 'head_changed', head: '' }))).toBeNull()
    expect(parseServerTextMessage(JSON.stringify({ type: 'head_changed', head: 42 }))).toBeNull()
  })

  it('rejects version_created when operator shape is invalid', () => {
    expect(
      parseServerTextMessage(
        JSON.stringify({
          type: 'version_created',
          version: {
            ...makeVersion(),
            operator: { kind: 'robot', peerId: 'peer-1' },
          },
        }),
      ),
    ).toBeNull()
  })
})
