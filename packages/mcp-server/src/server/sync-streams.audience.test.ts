/**
 * Which open pages each emitter reaches, against the real stream registry.
 * `sync-audience.test.ts` replaces the registry to check what is
 * sent, so it cannot see who it is sent to.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { sendAgentActivity, sendViewportRequest } from './sync-audience.js'
import {
  registerSyncStream,
  resetSyncStreamsForTests,
  type SyncStream,
  syncStreamStats,
} from './sync-streams.js'

afterEach(() => resetSyncStreamsForTests())

/** A registered stream holding the given documents, recording the frames it was sent. */
function pageHolding(streamId: string, docs: Record<string, { ready: boolean }>) {
  const frames: string[] = []
  const stream: SyncStream = {
    docs: new Map(Object.entries(docs).map(([as, { ready }]) => [as, { ready, key: as }] as const)),
    send: (_event, data) => frames.push(data),
    userId: null,
    end: () => {},
  }
  registerSyncStream(streamId, stream)
  return frames
}

describe('the audience of an agent announcement and of a viewport request', () => {
  it('sends agent activity to a page that has not signalled ready, and a viewport request only to a ready one', () => {
    const subscribed = pageHolding('s-subscribed', { 'ws-aud/doc': { ready: false } })
    const ready = pageHolding('s-ready', { 'ws-aud/doc': { ready: true } })

    sendAgentActivity('ws-aud', 'doc', {
      operator: { kind: 'ai' },
      touched: { nodes: ['n1'], edges: [] },
      summary: 'added 1',
    })
    expect([subscribed.length, ready.length]).toEqual([1, 1])
    expect(subscribed[0]).toContain('agent_activity')

    sendViewportRequest('ws-aud', 'doc', 'req-aud', { mode: 'fit' })
    expect([subscribed.length, ready.length]).toEqual([1, 2])
    expect(ready[1]).toContain('viewport_request')
  })
})

describe('the stream statistics', () => {
  it('counts a page once as ready however many of its documents are, and not at all while none is', () => {
    pageHolding('s-none', { 'ws-stat/a': { ready: false } })
    pageHolding('s-one', { 'ws-stat/a': { ready: true }, 'ws-stat/b': { ready: false } })
    pageHolding('s-both', { 'ws-stat/a': { ready: true }, 'ws-stat/b': { ready: true } })

    expect(syncStreamStats()).toEqual({ connected: 3, ready: 2 })
  })
})
