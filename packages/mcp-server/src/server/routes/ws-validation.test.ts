import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  parseWsClientTextMessage,
  parseWsTargetFromRequestUrl,
} from './ws-validation.js'

describe('parseWsTargetFromRequestUrl', () => {
  it('accepts validated workspaceId and encoded slug', () => {
    expect(parseWsTargetFromRequestUrl('/ws/sess-1/nested%2Fslug', '127.0.0.1:3099')).toEqual({
      workspaceId: 'sess-1',
      slug: 'nested/slug',
    })
  })

  it('rejects invalid session ids before websocket upgrade', () => {
    expect(() => parseWsTargetFromRequestUrl('/ws/bad.sid/slug', '127.0.0.1:3099')).toThrow(
      /Invalid workspaceId/,
    )
  })

  it('rejects invalid slugs before websocket upgrade', () => {
    expect(() => parseWsTargetFromRequestUrl('/ws/sess-1/bad.slug', '127.0.0.1:3099')).toThrow(
      /Invalid slug/,
    )
  })

  it('rejects unencoded extra path segments', () => {
    expect(() => parseWsTargetFromRequestUrl('/ws/sess-1/nested/slug', '127.0.0.1:3099')).toThrow(
      /Invalid websocket path/,
    )
  })
})

describe('parseWsClientTextMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts the allowlisted client message types', () => {
    expect(parseWsClientTextMessage('{"type":"client_ready"}')).toEqual({
      type: 'client_ready',
    })
    expect(
      parseWsClientTextMessage(
        '{"type":"export_response","requestId":"req-1","data":"data:image/png;base64,abc"}',
      ),
    ).toEqual({
      type: 'export_response',
      requestId: 'req-1',
      data: 'data:image/png;base64,abc',
    })
    expect(
      parseWsClientTextMessage('{"type":"viewport_response","requestId":"req-2"}'),
    ).toEqual({
      type: 'viewport_response',
      requestId: 'req-2',
    })
  })

  it('returns null and warns for malformed or unknown messages', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseWsClientTextMessage('{')).toBeNull()
    expect(parseWsClientTextMessage('[]')).toBeNull()
    expect(parseWsClientTextMessage('{"type":"unknown"}')).toBeNull()
    expect(parseWsClientTextMessage('{"type":"export_response","requestId":"req-1"}')).toBeNull()
    expect(parseWsClientTextMessage('{"type":"viewport_response"}')).toBeNull()

    expect(warn).toHaveBeenCalledTimes(5)
  })
})
