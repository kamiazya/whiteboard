// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  syncMessageEventSchema,
  syncReadyEventSchema,
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
    // prevent: one stream serves many canvases.
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
