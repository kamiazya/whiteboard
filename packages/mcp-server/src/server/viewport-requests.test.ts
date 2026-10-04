import { describe, expect, it } from 'vitest'
import {
  cachedViewportRequest,
  cacheViewportRequest,
  VIEWPORT_REPLAY_TTL_MS,
} from './viewport-requests.js'

describe('the viewport request cache', () => {
  it('answers the latest frame recorded for a document key, and nothing for one never asked', () => {
    cacheViewportRequest('ws-1/board', '{"type":"viewport_request","requestId":"a"}')
    cacheViewportRequest('ws-1/board', '{"type":"viewport_request","requestId":"b"}')
    expect(cachedViewportRequest('ws-1/board')).toBe('{"type":"viewport_request","requestId":"b"}')
    expect(cachedViewportRequest('ws-1/other')).toBeUndefined()
  })

  it('replays a frame up to the window and not a millisecond past it', () => {
    cacheViewportRequest('ws-ttl/edge', 'frame', 1_000)
    expect(cachedViewportRequest('ws-ttl/edge', 1_000 + VIEWPORT_REPLAY_TTL_MS)).toBe('frame')
    expect(cachedViewportRequest('ws-ttl/edge', 1_000 + VIEWPORT_REPLAY_TTL_MS + 1)).toBeUndefined()
  })

  it('measures the window from the latest request, not the first', () => {
    cacheViewportRequest('ws-ttl/renewed', 'old', 0)
    cacheViewportRequest('ws-ttl/renewed', 'new', VIEWPORT_REPLAY_TTL_MS)
    expect(cachedViewportRequest('ws-ttl/renewed', VIEWPORT_REPLAY_TTL_MS * 2)).toBe('new')
  })

  it("leaves another document's still-fresh request replayable when one is recorded", () => {
    cacheViewportRequest('ws-keep/a', 'frame-a', 100)
    cacheViewportRequest('ws-keep/b', 'frame-b', 200)
    expect(cachedViewportRequest('ws-keep/a', 300)).toBe('frame-a')
    expect(cachedViewportRequest('ws-keep/b', 300)).toBe('frame-b')
  })

  it('does not sweep a request at the window edge, which a read would still replay', () => {
    cacheViewportRequest('ws-edge/a', 'frame-a', 0)
    cacheViewportRequest('ws-edge/b', 'frame-b', VIEWPORT_REPLAY_TTL_MS)
    expect(cachedViewportRequest('ws-edge/a', VIEWPORT_REPLAY_TTL_MS)).toBe('frame-a')
  })
})
