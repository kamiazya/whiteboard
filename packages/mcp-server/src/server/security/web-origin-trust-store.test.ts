import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createWebOriginTrustStore,
  getWebOriginTrustFilePath,
  hashReconnectSecret,
} from './web-origin-trust-store.js'

describe('web-origin-trust-store', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-web-origin-trust-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('trusts an origin and later verifies its secret round-trips', async () => {
    const store = createWebOriginTrustStore({ dataDir })

    const { secret } = await store.trustOrigin('http://localhost:5173')

    const verified = await store.verify('http://localhost:5173', secret)
    expect(verified).toBe(true)
  })

  it('rejects an unknown origin even with a syntactically valid secret', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')

    const verified = await store.verify('http://localhost:9999', 'not-a-real-secret')
    expect(verified).toBe(false)
  })

  it('rejects a wrong secret for a trusted origin', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')

    const verified = await store.verify('http://localhost:5173', 'wrong-secret')
    expect(verified).toBe(false)
  })

  it('rotates the secret on rotate(), invalidating the old one', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    const { secret: oldSecret } = await store.trustOrigin('http://localhost:5173')

    const { secret: newSecret } = await store.rotate('http://localhost:5173')

    expect(await store.verify('http://localhost:5173', oldSecret)).toBe(false)
    expect(await store.verify('http://localhost:5173', newSecret)).toBe(true)
  })

  it('rotate() throws for an origin with no existing trust record', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await expect(store.rotate('http://never-trusted.example.com')).rejects.toThrow(
      /cannot rotate untrusted origin/,
    )
  })

  describe('verifyAndRotate', () => {
    it('verifies and rotates atomically, returning the new secret', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { secret: oldSecret } = await store.trustOrigin('http://localhost:5173')

      const result = await store.verifyAndRotate('http://localhost:5173', oldSecret)

      expect(result).not.toBeNull()
      expect(await store.verify('http://localhost:5173', oldSecret)).toBe(false)
      expect(await store.verify('http://localhost:5173', result?.secret ?? '')).toBe(true)
    })

    it('returns null instead of throwing for an unknown origin', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const result = await store.verifyAndRotate('http://never-trusted.example.com', 'anything')
      expect(result).toBeNull()
    })

    it('returns null for a wrong secret without rotating the real one', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { secret } = await store.trustOrigin('http://localhost:5173')

      expect(await store.verifyAndRotate('http://localhost:5173', 'wrong-secret')).toBeNull()
      // The real secret is still live — a failed attempt did not rotate it.
      expect(await store.verify('http://localhost:5173', secret)).toBe(true)
    })

    it('only one of two concurrent verifyAndRotate calls with the same secret succeeds', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { secret } = await store.trustOrigin('http://localhost:5173')

      const [first, second] = await Promise.all([
        store.verifyAndRotate('http://localhost:5173', secret),
        store.verifyAndRotate('http://localhost:5173', secret),
      ])

      const successes = [first, second].filter((r) => r !== null)
      expect(successes).toHaveLength(1)
    })
  })

  it('persists trust records to disk with owner-only permissions', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    const { secret } = await store.trustOrigin('http://localhost:5173')

    const filePath = getWebOriginTrustFilePath(dataDir)
    const raw = JSON.parse(await readFile(filePath, 'utf-8'))
    expect(raw.schemaVersion).toBe(1)
    expect(raw.origins).toHaveLength(1)
    expect(raw.origins[0].origin).toBe('http://localhost:5173')
    // Never persist the plaintext secret — only its hash.
    expect(raw.origins[0]).not.toHaveProperty('secret')
    expect(raw.origins[0].secretHash).toBe(hashReconnectSecret(secret))

    if (process.platform !== 'win32') {
      const info = await stat(filePath)
      expect(info.mode & 0o777).toBe(0o600)
    }
  })

  it('a fresh store instance re-reads a revoked origin from disk without restart', async () => {
    const storeA = createWebOriginTrustStore({ dataDir })
    const { secret } = await storeA.trustOrigin('http://localhost:5173')

    const storeB = createWebOriginTrustStore({ dataDir })
    await storeB.revoke('http://localhost:5173')

    // storeA must re-read the file (mtime-cached) rather than trust stale
    // in-memory state, so revocation from another process (the CLI) takes
    // effect on a running daemon without a restart.
    expect(await storeA.verify('http://localhost:5173', secret)).toBe(false)
  })

  it('tolerates a corrupt trust file as an empty store', async () => {
    await writeFile(getWebOriginTrustFilePath(dataDir), '{not json', 'utf-8')
    const store = createWebOriginTrustStore({ dataDir })
    expect(await store.list()).toEqual([])
  })

  it('expires a trust record past its sliding TTL', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const store = createWebOriginTrustStore({ dataDir, now: () => now })
    const { secret } = await store.trustOrigin('http://localhost:5173')

    now += 31 * 24 * 60 * 60 * 1000 // 31 days later
    expect(await store.verify('http://localhost:5173', secret)).toBe(false)
  })

  it('revokeAll empties the store', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')
    await store.trustOrigin('http://localhost:6000')

    await store.revokeAll()

    expect(await store.list()).toEqual([])
  })
})
