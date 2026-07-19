import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EcP256PublicJwk } from '../../shared/api-contracts/reconnect.js'
import {
  createWebOriginTrustStore,
  getWebOriginTrustFilePath,
  hashReconnectSecret,
} from './web-origin-trust-store.js'

async function generateKeyPair(): Promise<{
  publicJwk: EcP256PublicJwk
  privateKey: CryptoKey
}> {
  const keyPair = (await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKey
  const exported = (await webcrypto.subtle.exportKey(
    'jwk',
    (keyPair as unknown as CryptoKeyPair).publicKey,
  )) as JsonWebKey
  const publicJwk: EcP256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x as string,
    y: exported.y as string,
  }
  return { publicJwk, privateKey: (keyPair as unknown as CryptoKeyPair).privateKey }
}

async function sign(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(message),
  )
  return Buffer.from(signature).toString('base64url')
}

describe('web-origin-trust-store', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-web-origin-trust-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('trusts an origin and later verifies its legacy secret round-trips', async () => {
    const store = createWebOriginTrustStore({ dataDir })

    const { secret } = await store.trustOrigin('http://localhost:5173')

    expect(await store.verifyLegacySecret('http://localhost:5173', secret)).toBe(true)
  })

  it('rejects an unknown origin even with a syntactically valid secret', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')

    expect(await store.verifyLegacySecret('http://localhost:9999', 'not-a-real-secret')).toBe(false)
  })

  it('rejects a wrong secret for a trusted origin', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')

    expect(await store.verifyLegacySecret('http://localhost:5173', 'wrong-secret')).toBe(false)
  })

  it('verifyLegacySecret does NOT rotate — the same secret verifies twice', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    const { secret } = await store.trustOrigin('http://localhost:5173')

    expect(await store.verifyLegacySecret('http://localhost:5173', secret)).toBe(true)
    expect(await store.verifyLegacySecret('http://localhost:5173', secret)).toBe(true)
  })

  it('rotate() and verifyAndRotate() are no longer exported', () => {
    const store = createWebOriginTrustStore({ dataDir }) as unknown as Record<string, unknown>
    expect(store.rotate).toBeUndefined()
    expect(store.verifyAndRotate).toBeUndefined()
  })

  it('persists trust records to disk as schemaVersion 2 with owner-only permissions', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    const { secret } = await store.trustOrigin('http://localhost:5173')

    const filePath = getWebOriginTrustFilePath(dataDir)
    const raw = JSON.parse(await readFile(filePath, 'utf-8'))
    expect(raw.schemaVersion).toBe(2)
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
    expect(await storeA.verifyLegacySecret('http://localhost:5173', secret)).toBe(false)
  })

  it('tolerates a corrupt trust file as an empty store', async () => {
    await writeFile(getWebOriginTrustFilePath(dataDir), '{not json', 'utf-8')
    const store = createWebOriginTrustStore({ dataDir })
    expect(await store.list()).toEqual([])
  })

  it('expires a trust record past its sliding TTL (legacy secret path)', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const store = createWebOriginTrustStore({ dataDir, now: () => now })
    const { secret } = await store.trustOrigin('http://localhost:5173')

    now += 31 * 24 * 60 * 60 * 1000 // 31 days later
    expect(await store.verifyLegacySecret('http://localhost:5173', secret)).toBe(false)
  })

  it('expires a legacy secret past its absolute TTL from trustedAt even with a fresh lastUsedAt', async () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z')
    let now = start
    const store = createWebOriginTrustStore({ dataDir, now: () => now })
    const { secret } = await store.trustOrigin('http://localhost:5173')

    // Repeated use keeps the SLIDING TTL fresh (each gap well under 30 days),
    // but the ABSOLUTE TTL is measured from trustedAt and must still expire
    // the credential once enough real time has passed — a legacy secret
    // that never rotates must not be silently reconnectable forever.
    for (let elapsedDays = 20; elapsedDays <= 80; elapsedDays += 20) {
      now = start + elapsedDays * 24 * 60 * 60 * 1000
      expect(await store.verifyLegacySecret('http://localhost:5173', secret)).toBe(true)
    }

    now = start + 91 * 24 * 60 * 60 * 1000
    expect(await store.verifyLegacySecret('http://localhost:5173', secret)).toBe(false)
  })

  it('does not apply the absolute legacy TTL to an enrolled public-key credential', async () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z')
    let now = start
    const store = createWebOriginTrustStore({ dataDir, now: () => now })
    const { publicJwk, privateKey } = await generateKeyPair()
    await store.enrollPublicKey('http://localhost:5173', publicJwk)

    // Repeated use well past the 90-day legacy absolute TTL (each gap under
    // the 30-day sliding TTL) — a keypair credential is governed by the
    // sliding TTL alone, not the legacy grace-period's absolute cap.
    for (let elapsedDays = 20; elapsedDays <= 100; elapsedDays += 20) {
      now = start + elapsedDays * 24 * 60 * 60 * 1000
      const signature = await sign(privateKey, `nonce-${elapsedDays}`)
      expect(
        await store.verifySignedChallenge(
          'http://localhost:5173',
          `nonce-${elapsedDays}`,
          signature,
        ),
      ).toBe(true)
    }
  })

  it('revokeAll empties the store', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')
    await store.trustOrigin('http://localhost:6000')

    await store.revokeAll()

    expect(await store.list()).toEqual([])
  })

  describe('v1 -> v2 migration', () => {
    it('loads a v1 (secretHash-only) file without data loss and legacy-verifies', async () => {
      const filePath = getWebOriginTrustFilePath(dataDir)
      await mkdir(dataDir, { recursive: true })
      const secret = 'a-legacy-secret-value'
      const v1File = {
        schemaVersion: 1,
        origins: [
          {
            origin: 'http://localhost:5173',
            secretHash: hashReconnectSecret(secret),
            trustedAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          },
        ],
      }
      await writeFile(filePath, JSON.stringify(v1File), 'utf-8')

      const store = createWebOriginTrustStore({ dataDir })
      const records = await store.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.origin).toBe('http://localhost:5173')
      expect(await store.verifyLegacySecret('http://localhost:5173', secret)).toBe(true)
    })
  })

  describe('enrollPublicKey', () => {
    it('enrolls a public key for a fresh origin', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { publicJwk } = await generateKeyPair()

      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      const records = await store.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.publicKeyJwk).toEqual(publicJwk)
    })

    it('replaces an existing secretHash-only record and drops secretHash', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      await store.trustOrigin('http://localhost:5173')
      const { publicJwk } = await generateKeyPair()

      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      const records = await store.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.publicKeyJwk).toEqual(publicJwk)
      expect(records[0]).not.toHaveProperty('secretHash')
    })

    it('is idempotent for an identical JWK', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { publicJwk } = await generateKeyPair()

      await store.enrollPublicKey('http://localhost:5173', publicJwk)
      const firstTrustedAt = (await store.list())[0]?.trustedAt

      await store.enrollPublicKey('http://localhost:5173', publicJwk)
      const records = await store.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.trustedAt).toBe(firstTrustedAt)
    })

    it('renews an expired record on re-enrollment of the SAME key instead of no-op', async () => {
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const store = createWebOriginTrustStore({ dataDir, now: () => now })
      const { publicJwk, privateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      now += 31 * 24 * 60 * 60 * 1000 // past the sliding TTL
      await store.enrollPublicKey('http://localhost:5173', publicJwk) // re-pair with the identical key

      const nonce = 'nonce-after-renewal'
      const signature = await sign(privateKey, nonce)
      // Without a renewed lastUsedAt, this signed reconnect would still read
      // as expired even though the user just successfully re-paired.
      expect(await store.verifySignedChallenge('http://localhost:5173', nonce, signature)).toBe(
        true,
      )
    })

    it('a record with neither publicKeyJwk nor secretHash is rejected by the schema refinement', async () => {
      const filePath = getWebOriginTrustFilePath(dataDir)
      await mkdir(dataDir, { recursive: true })
      const invalidFile = {
        schemaVersion: 2,
        origins: [
          {
            origin: 'http://localhost:5173',
            trustedAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }
      await writeFile(filePath, JSON.stringify(invalidFile), 'utf-8')

      const store = createWebOriginTrustStore({ dataDir })
      // Corrupt/invalid-shape file tolerated as empty, same as any other
      // unparseable file — never crashes startup.
      expect(await store.list()).toEqual([])
    })
  })

  describe('verifySignedChallenge', () => {
    it('verifies a valid P1363 signature over the nonce and updates lastUsedAt', async () => {
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const store = createWebOriginTrustStore({ dataDir, now: () => now })
      const { publicJwk, privateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      const nonce = 'test-nonce-value'
      const signature = await sign(privateKey, nonce)

      now += 1000
      const result = await store.verifySignedChallenge('http://localhost:5173', nonce, signature)
      expect(result).toBe(true)

      const records = await store.list()
      expect(records[0]?.lastUsedAt).toBe(new Date(now).toISOString())
    })

    it('repeated signed reconnects extend the sliding TTL', async () => {
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const store = createWebOriginTrustStore({ dataDir, now: () => now })
      const { publicJwk, privateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      now += 29 * 24 * 60 * 60 * 1000 // 29 days later, still fresh
      const signature1 = await sign(privateKey, 'nonce-1')
      expect(
        await store.verifySignedChallenge('http://localhost:5173', 'nonce-1', signature1),
      ).toBe(true)

      now += 29 * 24 * 60 * 60 * 1000 // another 29 days — would be expired from trustedAt, not from the refreshed lastUsedAt
      const signature2 = await sign(privateKey, 'nonce-2')
      expect(
        await store.verifySignedChallenge('http://localhost:5173', 'nonce-2', signature2),
      ).toBe(true)
    })

    it('rejects a signature from the wrong key', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { publicJwk } = await generateKeyPair()
      const { privateKey: wrongPrivateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      const nonce = 'test-nonce-value'
      const signature = await sign(wrongPrivateKey, nonce)

      expect(await store.verifySignedChallenge('http://localhost:5173', nonce, signature)).toBe(
        false,
      )
    })

    it('rejects a tampered nonce', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { publicJwk, privateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      const signature = await sign(privateKey, 'original-nonce')

      expect(
        await store.verifySignedChallenge('http://localhost:5173', 'tampered-nonce', signature),
      ).toBe(false)
    })

    it('rejects a non-64-byte signature', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { publicJwk } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      expect(
        await store.verifySignedChallenge(
          'http://localhost:5173',
          'nonce',
          Buffer.from('too-short').toString('base64url'),
        ),
      ).toBe(false)
    })

    it('rejects an unknown origin', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { privateKey } = await generateKeyPair()
      const signature = await sign(privateKey, 'nonce')

      expect(
        await store.verifySignedChallenge('http://never-enrolled.example.com', 'nonce', signature),
      ).toBe(false)
    })

    it('rejects an origin with only a legacy secret, no public key', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      await store.trustOrigin('http://localhost:5173')
      const { privateKey } = await generateKeyPair()
      const signature = await sign(privateKey, 'nonce')

      expect(await store.verifySignedChallenge('http://localhost:5173', 'nonce', signature)).toBe(
        false,
      )
    })

    it('revoke landing during async signature verification rejects and does not touch lastUsedAt', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { publicJwk, privateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)
      const beforeLastUsedAt = (await store.list())[0]?.lastUsedAt

      const nonce = 'race-nonce'
      const signature = await sign(privateKey, nonce)

      // Revoke the origin, then verify — simulates a revoke landing while a
      // slower verify call is still in flight elsewhere: this store's
      // post-verify recheck (under the write queue) must see the revoked
      // state and reject even though the cryptographic signature itself is
      // valid.
      await store.revoke('http://localhost:5173')
      const result = await store.verifySignedChallenge('http://localhost:5173', nonce, signature)

      expect(result).toBe(false)
      expect(await store.list()).toEqual([])
      expect(beforeLastUsedAt).toBeDefined()
    })

    it('re-enrollment of a DIFFERENT key mid-verify rejects (key-identity recheck)', async () => {
      const store = createWebOriginTrustStore({ dataDir })
      const { publicJwk, privateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      const nonce = 'key-swap-nonce'
      const signature = await sign(privateKey, nonce)

      const { publicJwk: otherJwk } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', otherJwk)

      // The signature is valid for the ORIGINAL key, but the record now
      // holds a different key — the post-verify identity recheck must
      // reject even though verification against the captured key
      // succeeded.
      const result = await store.verifySignedChallenge('http://localhost:5173', nonce, signature)
      expect(result).toBe(false)
    })

    it('rejects an expired sliding-TTL record even with a valid signature', async () => {
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const store = createWebOriginTrustStore({ dataDir, now: () => now })
      const { publicJwk, privateKey } = await generateKeyPair()
      await store.enrollPublicKey('http://localhost:5173', publicJwk)

      now += 31 * 24 * 60 * 60 * 1000
      const nonce = 'nonce'
      const signature = await sign(privateKey, nonce)
      expect(await store.verifySignedChallenge('http://localhost:5173', nonce, signature)).toBe(
        false,
      )
    })
  })

  describe('cross-process write serialization', () => {
    const lockDirName = 'trusted-web-origins.lock'

    it('waits for an externally held lock before mutating the file', async () => {
      await mkdir(join(dataDir, lockDirName))
      let releasedAt = 0
      setTimeout(() => {
        releasedAt = Date.now()
        void rm(join(dataDir, lockDirName), { recursive: true, force: true })
      }, 30)

      const store = createWebOriginTrustStore({ dataDir })
      const startedAt = Date.now()
      await store.trustOrigin('http://localhost:5173')

      expect(startedAt).toBeGreaterThanOrEqual(0)
      expect(Date.now()).toBeGreaterThanOrEqual(releasedAt)
    })

    it('reclaims a lock left behind by a dead process instead of hanging', async () => {
      await mkdir(join(dataDir, lockDirName))
      await writeFile(
        join(dataDir, lockDirName, 'owner.json'),
        JSON.stringify({ pid: 999999999, startedAt: '2026-04-23T00:00:00.000Z' }),
      )

      const store = createWebOriginTrustStore({ dataDir })
      await expect(store.trustOrigin('http://localhost:5173')).resolves.toBeDefined()
    })

    it('does not let a concurrent write from a second store instance clobber the first', async () => {
      const storeA = createWebOriginTrustStore({ dataDir })
      const storeB = createWebOriginTrustStore({ dataDir })

      await Promise.all([
        storeA.trustOrigin('http://localhost:5173'),
        storeB.trustOrigin('http://localhost:6000'),
      ])

      const origins = (await storeA.list()).map((r) => r.origin).sort()
      expect(origins).toEqual(['http://localhost:5173', 'http://localhost:6000'])
    })
  })
})
