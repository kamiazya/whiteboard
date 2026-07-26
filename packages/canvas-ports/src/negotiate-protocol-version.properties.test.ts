import { describe, expect } from 'vitest'
import { negotiateProtocolVersion } from './sync-protocol.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('negotiateProtocolVersion properties', () => {
  fcTest.prop(
    [fc.array(fc.integer({ min: 1, max: 20 })), fc.array(fc.integer({ min: 1, max: 20 }))],
    withDefaults(),
  )(
    'result is null or an element of the intersection, and equals its max when non-null',
    (client, server) => {
      const result = negotiateProtocolVersion(client, server)
      const intersection = client.filter((v) => server.includes(v))

      if (intersection.length === 0) {
        expect(result).toBeNull()
      } else {
        expect(result).toBe(Math.max(...intersection))
      }
    },
  )
})
