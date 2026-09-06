import { fc, test as propertyTest } from '@fast-check/vitest'
import type { CommentMessage, CommentThread } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { threadLastActivityAt } from './thread-activity.js'

function threadOf(messages: readonly CommentMessage[]): CommentThread {
  return {
    id: 't-1',
    anchor: { kind: 'document' },
    status: 'open',
    messages: messages as CommentThread['messages'],
  }
}

describe('when a conversation last moved', () => {
  it('takes the newest message rather than the opening one', () => {
    expect(
      threadLastActivityAt(
        threadOf([
          { id: 'm1', body: 'is this right?', createdAt: '2026-09-01T10:00:00.000Z' },
          { id: 'm2', body: 'no', createdAt: '2026-09-04T09:00:00.000Z' },
        ]),
      ),
    ).toBe('2026-09-04T09:00:00.000Z')
  })

  it('counts an EDIT as movement: a rewritten subject is news to whoever read it', () => {
    expect(
      threadLastActivityAt(
        threadOf([
          {
            id: 'm1',
            body: 'rewritten',
            createdAt: '2026-09-01T10:00:00.000Z',
            editedAt: '2026-09-05T08:00:00.000Z',
          },
          { id: 'm2', body: 'no', createdAt: '2026-09-04T09:00:00.000Z' },
        ]),
      ),
    ).toBe('2026-09-05T08:00:00.000Z')
  })

  it('orders by INSTANT, not by text — an OKF stamp may carry any offset', () => {
    // Midnight in Tokyo is the earlier instant, and the later string. Sorted
    // as text this answers the Tokyo stamp, which is a conversation reported
    // as fresher than it is.
    expect(
      threadLastActivityAt(
        threadOf([
          { id: 'm1', body: 'first', createdAt: '2026-09-06T00:00:00+09:00' },
          { id: 'm2', body: 'second', createdAt: '2026-09-05T16:30:00Z' },
        ]),
      ),
    ).toBe('2026-09-05T16:30:00Z')
  })

  it('answers undefined for a conversation whose keeper stamps nothing', () => {
    // A browser-kept workspace has no signed-in author and may have no clock
    // written into the record; the surfaces read this as "say nothing" rather
    // than inventing a time.
    expect(threadLastActivityAt(threadOf([{ id: 'm1', body: 'no stamp' }]))).toBeUndefined()
  })

  it('ignores the unstamped messages beside a stamped one', () => {
    expect(
      threadLastActivityAt(
        threadOf([
          { id: 'm1', body: 'no stamp' },
          { id: 'm2', body: 'stamped', createdAt: '2026-09-04T09:00:00.000Z' },
        ]),
      ),
    ).toBe('2026-09-04T09:00:00.000Z')
  })
})

/**
 * Offsets are generated, not assumed away: `okfTimestampSchema` accepts
 * `Z` and `±HH:MM` alike, so a generator that only ever emits `Z` cannot
 * reach the case the example above pins.
 */
const stamp = fc
  .record({
    instant: fc.date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2100-01-01T00:00:00Z'),
    }),
    offsetMinutes: fc.constantFrom(0, 60, 330, 540, -300, -480),
  })
  .map(({ instant, offsetMinutes }) => {
    if (offsetMinutes === 0) return instant.toISOString()
    const shifted = new Date(instant.getTime() + offsetMinutes * 60_000)
    const sign = offsetMinutes > 0 ? '+' : '-'
    const abs = Math.abs(offsetMinutes)
    const hh = String(Math.floor(abs / 60)).padStart(2, '0')
    const mm = String(abs % 60).padStart(2, '0')
    return `${shifted.toISOString().slice(0, -1)}${sign}${hh}:${mm}`
  })

const message = fc
  .record(
    {
      id: fc.string({ minLength: 1, maxLength: 8 }),
      body: fc.string({ minLength: 1, maxLength: 12 }),
      createdAt: stamp,
      editedAt: stamp,
    },
    { requiredKeys: ['id', 'body'] },
  )
  .map((one) => one as CommentMessage)

describe('the last-activity stamp, over any conversation', () => {
  propertyTest.prop([fc.array(message, { minLength: 1, maxLength: 6 })])(
    'is one of the conversation own stamps, and no stamp is later than it',
    (messages) => {
      const stamps = messages.flatMap((one) =>
        [one.createdAt, one.editedAt].filter((v): v is string => v !== undefined),
      )
      const answer = threadLastActivityAt(threadOf(messages))
      if (stamps.length === 0) {
        expect(answer).toBeUndefined()
        return
      }
      expect(stamps).toContain(answer)
      const at = Date.parse(answer as string)
      for (const one of stamps) expect(Date.parse(one)).toBeLessThanOrEqual(at)
    },
  )
})
