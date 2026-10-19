// @vitest-environment node
import { DOCUMENT_PATH_MAX_LENGTH, WORKSPACE_SEGMENT_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  syncClientMessageRequestSchema,
  syncMessageEventSchema,
  syncReadyEventSchema,
  syncSubscribeRequestSchema,
  syncUpdateEventSchema,
} from './sync-sse-contract.js'

describe('sync SSE frame contract', () => {
  it('accepts the frames the daemon emits', () => {
    expect(syncReadyEventSchema.safeParse({ streamId: 's-1' }).success).toBe(true)
    expect(syncUpdateEventSchema.safeParse({ doc: 'w/a', update: 'AQID' }).success).toBe(true)
    expect(syncMessageEventSchema.safeParse({ doc: 'w/a', raw: '{"type":"x"}' }).success).toBe(true)
  })

  it('rejects a frame missing its addressing', () => {
    // An unaddressed frame is the misrouting hazard the doc key exists to
    // prevent: one stream serves many documents.
    expect(syncUpdateEventSchema.safeParse({ update: 'AQID' }).success).toBe(false)
    expect(syncMessageEventSchema.safeParse({ raw: '{}' }).success).toBe(false)
    expect(syncReadyEventSchema.safeParse({ streamId: '' }).success).toBe(false)
  })

  it('rejects a field of the wrong type rather than coercing it', () => {
    expect(syncUpdateEventSchema.safeParse({ doc: 'w/a', update: 123 }).success).toBe(false)
    expect(syncMessageEventSchema.safeParse({ doc: 'w/a', raw: { type: 'x' } }).success).toBe(false)
  })

  it('ignores an unknown field instead of dropping the frame', () => {
    // The daemon is installed locally and the page auto-updates, so their
    // versions skew by design. Rejecting here would stop sync outright on every
    // older client the moment a frame gained a field.
    const parsed = syncUpdateEventSchema.safeParse({ doc: 'w/a', update: 'AQID', seq: 7 })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({ doc: 'w/a', update: 'AQID' })
  })
})

describe('a doc key a sync request names', () => {
  // The longest key the client really writes: a segment-length handle, then
  // a path at its own limit.
  const longest = `${'h'.repeat(WORKSPACE_SEGMENT_MAX_LENGTH)}/${'p'.repeat(DOCUMENT_PATH_MAX_LENGTH)}`
  const subscribing = (key: string) =>
    syncSubscribeRequestSchema.safeParse({ streamId: 's', subscribe: [key] }).success
  const unsubscribing = (key: string) =>
    syncSubscribeRequestSchema.safeParse({ streamId: 's', unsubscribe: [key] }).success
  const messaging = (key: string) =>
    syncClientMessageRequestSchema.safeParse({
      streamId: 's',
      doc: key,
      message: { type: 'client_ready' },
    }).success

  it.each([
    ['subscribe', subscribing],
    ['unsubscribe', unsubscribing],
    ['message', messaging],
  ])('is accepted by %s up to the longest real key and refused one past it', (_, parses) => {
    expect(parses(longest)).toBe(true)
    expect(parses(`${longest}p`)).toBe(false)
  })

  it.each([
    ['subscribe', subscribing],
    ['unsubscribe', unsubscribing],
    ['message', messaging],
  ])('is refused by %s when it names no workspace', (_, parses) => {
    expect(parses('workspace:01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true)
    expect(parses('ws/doc')).toBe(true)
    for (const key of ['no-slash', 'workspace:', '/doc', 'ws/']) expect(parses(key)).toBe(false)
  })
})
