import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { buildSignedPayload, createDaemonIdentity } from './daemon-identity.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-daemon-identity-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function verifySignature(publicKeyB64u: string, parts: readonly string[], signatureB64u: string) {
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64u },
    format: 'jwk',
  })
  return cryptoVerify(null, buildSignedPayload(parts), key, Buffer.from(signatureB64u, 'base64url'))
}

describe('createDaemonIdentity', () => {
  it('generates a persisted Ed25519 identity on first start', () => {
    const identity = createDaemonIdentity({ dataDir: dir })

    expect(identity.alg).toBe('Ed25519')
    // Raw Ed25519 public key: 32 bytes, base64url.
    expect(Buffer.from(identity.publicKey, 'base64url')).toHaveLength(32)
    const stat = statSync(join(dir, 'daemon-identity.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('reloads the SAME identity across restarts', () => {
    const first = createDaemonIdentity({ dataDir: dir })
    const second = createDaemonIdentity({ dataDir: dir })
    expect(second.publicKey).toBe(first.publicKey)
  })

  it('signatures verify against the advertised public key', () => {
    const identity = createDaemonIdentity({ dataDir: dir })
    const parts = ['wb-verify-v1', 'nonce-abc', 'https://example.com'] as const
    const signature = identity.sign(parts)
    expect(verifySignature(identity.publicKey, parts, signature)).toBe(true)
    // A different message must not verify.
    expect(verifySignature(identity.publicKey, ['wb-verify-v1', 'other', ''], signature)).toBe(
      false,
    )
  })

  it('part boundaries are unambiguous (["ab","c"] never collides with ["a","bc"])', () => {
    expect(buildSignedPayload(['ab', 'c'])).not.toEqual(buildSignedPayload(['a', 'bc']))
  })

  it('a corrupt identity file regenerates (rotation semantics) with a warning', () => {
    const first = createDaemonIdentity({ dataDir: dir })
    writeFileSync(join(dir, 'daemon-identity.json'), '{not json')
    chmodSync(join(dir, 'daemon-identity.json'), 0o600)

    const capture = captureLogsForTests('debug')
    try {
      const second = createDaemonIdentity({ dataDir: dir })
      expect(second.publicKey).not.toBe(first.publicKey)
      const record = capture.records.find(
        (r) => r.scope === 'daemon-identity' && r.level === 'warning',
      )
      expect(record).toBeDefined()
      // The regenerated identity must persist and reload stably.
      const third = createDaemonIdentity({ dataDir: dir })
      expect(third.publicKey).toBe(second.publicKey)
    } finally {
      capture.restore()
    }
  })

  it('a wrong-shape identity file rotates without echoing its private key into logs', () => {
    createDaemonIdentity({ dataDir: dir })
    const plantedD = 'PLANTED-PRIVATE-KEY-MATERIAL-d'
    writeFileSync(
      join(dir, 'daemon-identity.json'),
      JSON.stringify({
        version: 999,
        alg: 'Ed25519',
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
        privateJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', d: plantedD },
      }),
    )
    const capture = captureLogsForTests('debug')
    try {
      const rotated = createDaemonIdentity({ dataDir: dir })
      expect(Buffer.from(rotated.publicKey, 'base64url')).toHaveLength(32)
      const record = capture.records.find(
        (r) => r.scope === 'daemon-identity' && r.level === 'warning',
      )
      expect(record).toBeDefined()
      expect(JSON.stringify(capture.records)).not.toContain(plantedD)
    } finally {
      capture.restore()
    }
  })

  it('never leaks the private key through the returned object or logs', () => {
    const capture = captureLogsForTests('debug')
    try {
      const identity = createDaemonIdentity({ dataDir: dir })
      expect(Object.keys(identity).sort()).toEqual(['alg', 'publicKey', 'sign'])
      const raw = readFileSync(join(dir, 'daemon-identity.json'), 'utf8')
      const privateD = JSON.parse(raw).privateJwk.d
      expect(typeof privateD).toBe('string')
      expect(JSON.stringify(capture.records)).not.toContain(privateD)
    } finally {
      capture.restore()
    }
  })
})
