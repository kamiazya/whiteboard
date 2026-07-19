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

// Rejecting (not resolving) on deleteDatabase failure matters: a resolved
// error would leave a stale keypair in place, so a later getOrCreateKeypair
// call could just load it instead of racing to create one, making the
// convergence assertions below pass vacuously without exercising the race.
async function clearDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    // An open connection from a prior run would otherwise block the delete
    // and hang the test until timeout; surface it as a failure instead.
    req.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

describe('reconnect keypair store: concurrent getOrCreateKeypair convergence (property)', () => {
  fcTest.prop([fc.integer({ min: 2, max: 6 })], { numRuns: 15 })(
    'N concurrent getOrCreateKeypair calls for one origin all resolve to the same stored keyId',
    async (concurrentCallCount) => {
      // fc reruns this body per generated case; each origin/DB must start
      // empty or an earlier run's stored key would make this run vacuously
      // pass no matter how the concurrency behaves.
      await clearDb()
      const origin = `http://localhost:${3000 + concurrentCallCount}`

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

      await clearDb()
    },
  )
})
