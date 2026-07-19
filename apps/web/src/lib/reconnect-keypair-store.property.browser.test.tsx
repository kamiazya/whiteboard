/**
 * Property under test: however many tabs race getOrCreateKeypair for the
 * same origin at the same time, they converge on exactly one persisted
 * keypair — every resolved keyId is identical, and loadKeypair afterward
 * returns that same keyId. Real IndexedDB + real WebCrypto (jsdom has
 * neither), so this lives in web-browser. The fixed N=2 case is covered by
 * reconnect-keypair-store.browser.test.tsx; this file generalizes to N in
 * [2,6].
 */
import { describe, expect } from 'vitest'
import { fc, fcTest } from '@/test-utils/fast-check.js'
import { exportPublicJwk } from './reconnect-crypto.js'
import { getOrCreateKeypair, loadKeypair } from './reconnect-keypair-store.js'

// Each property iteration uses a unique origin so prior iterations' open
// IndexedDB connections (which linger until GC) never block deleteDatabase.
let iterationCounter = 0

describe('reconnect keypair store: concurrent getOrCreateKeypair convergence (property)', () => {
  fcTest.prop([fc.integer({ min: 2, max: 6 })], { numRuns: 15 })(
    'N concurrent getOrCreateKeypair calls for one origin all resolve to the same stored keyId',
    async (concurrentCallCount) => {
      // Each iteration gets a unique origin so it starts with no stored key
      // — avoids deleteDatabase which blocks on lingering connections from
      // prior iterations (IndexedDB connections are GC'd, not explicitly closed).
      const origin = `http://localhost:${10000 + iterationCounter++}`

      const results = await Promise.all(
        Array.from({ length: concurrentCallCount }, () => getOrCreateKeypair(origin)),
      )

      const keyIds = new Set(results.map((r) => r.keyId))
      expect(keyIds.size).toBe(1)

      const jwks = await Promise.all(results.map((r) => exportPublicJwk(r.publicKey)))
      const [firstJwk, ...restJwks] = jwks
      for (const jwk of restJwks) {
        expect(jwk).toEqual(firstJwk)
      }

      const reloaded = await loadKeypair(origin)
      expect(reloaded?.keyId).toBe(results[0]?.keyId)
    },
  )
})
