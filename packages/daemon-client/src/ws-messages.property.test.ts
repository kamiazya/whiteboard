/**
 * What `serverTextMessageSchema` admits is what the wire can carry and
 * `parseServerTextMessage` hands back — a schema construct JSON cannot
 * carry (a Date, a bigint, a transform) would be a frame the browser
 * loses. That is all this lane can say: its generator is built from the
 * parser's own schema, so a drift between the two ends is invisible here
 * and is mcp-server's `ws-emitters.property.test.ts` to catch, by driving
 * the daemon's emitters against this parser. What this file adds beside
 * the round trip is the arms tally: every message kind is drawn.
 */
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, describe, expect, vi } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { serverTextMessageSchema, viewportRequestParamsSchema } from './ws-messages.js'
import { parseServerTextMessage } from './ws-text-message.js'

const ARMS = serverTextMessageSchema.options.map((arm) => arm.shape.type.value)
const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const seen = new Map<string, number>()

describe('server text messages survive the wire', () => {
  fcTest.prop([arbitraryForSchema(serverTextMessageSchema)], withDefaults())(
    'every message the schema admits parses back equal after JSON.stringify',
    (message) => {
      seen.set(message.type, (seen.get(message.type) ?? 0) + 1)
      const warn = vi.fn()
      // Modulo JSON's own identities (`-0` travels as `0`): what the
      // browser must not do is refuse the frame or strip a field.
      expect(parseServerTextMessage(JSON.stringify(message), warn)).toEqual(viaJson(message))
      expect(warn).not.toHaveBeenCalled()
    },
  )

  fcTest.prop(
    [arbitraryForSchema(viewportRequestParamsSchema), fc.string({ minLength: 1 })],
    withDefaults(),
  )(
    'a viewport request built from admitted params is a message the browser reads',
    (params, requestId) => {
      const message = { type: 'viewport_request' as const, requestId, ...params }
      expect(parseServerTextMessage(JSON.stringify(message), vi.fn())).toEqual(viaJson(message))
    },
  )

  afterAll(() => {
    const unreached = ARMS.filter((arm) => (seen.get(arm) ?? 0) === 0)
    expect(
      unreached,
      `message kinds the generator never drew: ${JSON.stringify([...seen])}`,
    ).toEqual([])
  })
})
