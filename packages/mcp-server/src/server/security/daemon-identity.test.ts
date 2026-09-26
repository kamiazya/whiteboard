import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_DENY_FILE_READ } from '../../shared/test-utils/can-deny-file-read.js'
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

  it.skipIf(!CAN_DENY_FILE_READ)(
    'refuses to start on an identity it cannot READ, rather than replacing it',
    () => {
      // Replacing is what `tryLoad` answered for ANY read error, and a
      // replaced identity is indistinguishable, to every paired client that
      // pinned it, from someone else answering on this port.
      createDaemonIdentity({ dataDir: dir })
      const file = join(dir, 'daemon-identity.json')
      const before = readFileSync(file, 'utf8')
      chmodSync(file, 0o000)
      try {
        expect(() => createDaemonIdentity({ dataDir: dir })).toThrow()
      } finally {
        chmodSync(file, 0o600)
      }
      expect(readFileSync(file, 'utf8')).toBe(before)
    },
  )

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
      // Pin the sanitized-record contract itself: only a reason class, never
      // the error object — ZodError happens not to echo input today, but the
      // moment someone logs { err } this assertion fails rather than relying
      // on that library behavior staying true.
      expect(record).toMatchObject({ data: { reason: 'invalid-shape' } })
      expect(record && 'err' in (record.data as Record<string, unknown>)).toBe(false)
    } finally {
      capture.restore()
    }
  })

  it('never leaks the private key through the returned object or logs', () => {
    const capture = captureLogsForTests('debug')
    try {
      const identity = createDaemonIdentity({ dataDir: dir })
      expect(Object.keys(identity).sort()).toEqual(['alg', 'did', 'publicKey', 'sign'])
      const raw = readFileSync(join(dir, 'daemon-identity.json'), 'utf8')
      const privateD = JSON.parse(raw).privateJwk.d
      expect(typeof privateD).toBe('string')
      expect(JSON.stringify(capture.records)).not.toContain(privateD)
    } finally {
      capture.restore()
    }
  })
})

// PROBED, never inferred: these need a mode they SET to be a mode the store
// READS BACK. Not the root question — the guard reads `statSync().mode`
// rather than attempting a denied read, so uid 0 changes nothing.
function probeChmodIsObservable(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-mode-probe-'))
  try {
    const file = join(probeDir, 'f')
    writeFileSync(file, 'x')
    chmodSync(file, 0o644)
    return (statSync(file).mode & 0o777) === 0o644
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
const CHMOD_IS_OBSERVABLE = probeChmodIsObservable()

// The twin of the macaroon case, and the reason #32 was deferred until both
// could land together: these two stores are deliberate copies of each other's
// posture, so a guard on one and not the other is the drift that made the
// original nitpick worth answering at all.
describe('createDaemonIdentity refuses a leaked identity file', () => {
  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'throws on a group-readable identity instead of regenerating',
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'wb-identity-leaked-'))
      try {
        const before = createDaemonIdentity({ dataDir }).did
        const filepath = join(dataDir, 'daemon-identity.json')
        chmodSync(filepath, 0o604)

        expect(() => createDaemonIdentity({ dataDir })).toThrow(/group or other/i)
        // Regenerating would change the daemon's did:key and break every
        // existing pairing, so refusing has to be what happens.
        chmodSync(filepath, 0o600)
        expect(createDaemonIdentity({ dataDir }).did).toBe(before)
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'writes the identity owner-only even over a leftover temp file',
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'wb-identity-tmp-'))
      try {
        const filepath = join(dataDir, 'daemon-identity.json')
        writeFileSync(`${filepath}.tmp`, 'stale')
        chmodSync(`${filepath}.tmp`, 0o644)

        createDaemonIdentity({ dataDir })

        expect(statSync(filepath).mode & 0o777).toBe(0o600)
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )
})
