import { describe, expect, it } from 'vitest'
import { cachedViewportRequest, cacheViewportRequest } from './viewport-requests.js'

describe('the viewport request cache', () => {
  it('answers the latest frame recorded for a document key, and nothing for one never asked', () => {
    cacheViewportRequest('ws-1/board', '{"type":"viewport_request","requestId":"a"}')
    cacheViewportRequest('ws-1/board', '{"type":"viewport_request","requestId":"b"}')
    expect(cachedViewportRequest('ws-1/board')).toBe('{"type":"viewport_request","requestId":"b"}')
    expect(cachedViewportRequest('ws-1/other')).toBeUndefined()
  })
})
