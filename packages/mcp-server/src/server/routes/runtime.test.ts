import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hermetic harness — these tests must NEVER touch the developer's real
// data directory. Stub `../config.js` (DATA_DIR) and the helpers behind
// /api/runtime/storage + /api/runtime/logs/prune so a buggy route can
// not delete real daemon logs or stat the user's blobs/.
const mockComputeStorageReport = vi.fn(async () => ({
  totalBytes: 0,
  fileCount: 0,
  byCategory: {
    blobs: { bytes: 0, files: 0 },
    versions: { bytes: 0, files: 0 },
    files: { bytes: 0, files: 0 },
    libraries: { bytes: 0, files: 0 },
    db: { bytes: 0, files: 0 },
    exports: { bytes: 0, files: 0 },
    logs: { bytes: 0, files: 0 },
    other: { bytes: 0, files: 0 },
  },
}))
const mockReadLatestCompactedAt = vi.fn<() => Promise<number | null>>(async () => null)
const mockPurgeOldDaemonLogs = vi.fn(async () => ({ removed: 0, retained: 0 }))

vi.mock('../config.js', () => ({
  DATA_DIR: '/__test__/runtime-routes-must-not-touch-real-disk',
  getDataDir: () => '/__test__/runtime-routes-must-not-touch-real-disk',
  WHITEBOARD_ROOT: '/__test__',
  REPO_ROOT: '/__test__',
}))
vi.mock('./runtime-storage.js', () => ({
  computeStorageReport: (dir: string) => mockComputeStorageReport(dir),
}))
vi.mock('../store/canvas-store.js', () => ({
  readLatestCompactedAt: () => mockReadLatestCompactedAt(),
}))
vi.mock('../../daemon/log-rotation.js', () => ({
  purgeOldDaemonLogs: (dir: string) => mockPurgeOldDaemonLogs(dir),
}))

const { createRuntimeRouter } = await import('./runtime.js')
const { buildSignedPayload, createDaemonIdentity } = await import('../security/daemon-identity.js')

// Real identity in an isolated temp dir (injected — the router never touches
// the mocked config seam for it).
const identityDir = mkdtempSync(join(tmpdir(), 'wb-runtime-identity-'))
const testIdentity = createDaemonIdentity({ dataDir: identityDir })
process.once('exit', () => rmSync(identityDir, { recursive: true, force: true }))

function verifyIdentitySignature(parts: readonly string[], signatureB64u: string) {
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: testIdentity.publicKey },
    format: 'jwk',
  })
  return cryptoVerify(null, buildSignedPayload(parts), key, Buffer.from(signatureB64u, 'base64url'))
}

function createApp() {
  const touch = vi.fn()
  const shutdown = vi.fn(async () => undefined)
  const app = createRuntimeRouter({
    token: 'secret',
    instanceId: 'test-instance-id',
    identity: testIdentity,
    touch,
    shutdown,
    getStatus: () => ({
      pid: 10,
      port: 3099,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 50,
      connectedClients: 2,
      readyClients: 1,
    }),
  })

  return { app, touch, shutdown }
}

beforeEach(() => {
  mockComputeStorageReport.mockClear()
  mockReadLatestCompactedAt.mockClear()
  mockPurgeOldDaemonLogs.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runtime routes', () => {
  it('allows unauthenticated ping', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/ping')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      instanceId: 'test-instance-id',
      identity: { alg: 'Ed25519', publicKey: testIdentity.publicKey },
    })
  })

  it('rejects status without a bearer token', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/status')
    expect(res.status).toBe(401)
  })

  it('returns runtime status with authorization', async () => {
    const { app, touch } = createApp()
    const res = await app.request('/api/runtime/status', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      pid: 10,
      port: 3099,
      connectedClients: 2,
      readyClients: 1,
    })
    expect(touch).toHaveBeenCalledTimes(1)
  })

  it('schedules shutdown when authenticated', async () => {
    const { app, shutdown, touch } = createApp()
    const res = await app.request('/api/runtime/shutdown', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    expect(touch).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('returns a storage report for an authenticated GET /api/runtime/storage', async () => {
    mockComputeStorageReport.mockResolvedValueOnce({
      totalBytes: 4096,
      fileCount: 3,
      byCategory: {
        blobs: { bytes: 4096, files: 3 },
        versions: { bytes: 0, files: 0 },
        files: { bytes: 0, files: 0 },
        libraries: { bytes: 0, files: 0 },
        db: { bytes: 0, files: 0 },
        exports: { bytes: 0, files: 0 },
        logs: { bytes: 0, files: 0 },
        other: { bytes: 0, files: 0 },
      },
    })
    mockReadLatestCompactedAt.mockResolvedValueOnce(1_700_000_000_000)

    const { app, touch } = createApp()
    const res = await app.request('/api/runtime/storage', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totalBytes: number
      fileCount: number
      byCategory: Record<string, { bytes: number; files: number }>
      lastAutoCompactedAt: number | null
    }
    expect(body.totalBytes).toBe(4096)
    expect(body.fileCount).toBe(3)
    expect(body.byCategory.blobs).toEqual({ bytes: 4096, files: 3 })
    expect(body.lastAutoCompactedAt).toBe(1_700_000_000_000)
    expect(touch).toHaveBeenCalledTimes(1)
    expect(mockComputeStorageReport).toHaveBeenCalledTimes(1)
  })

  it('rejects /api/runtime/storage without a bearer token', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/storage')
    expect(res.status).toBe(401)
    expect(mockComputeStorageReport).not.toHaveBeenCalled()
  })

  it('rejects POST /api/runtime/logs/prune without a bearer token', async () => {
    // Mutating runtime route — must be authenticated when the daemon was
    // started with a token. The global daemon-mutation middleware in app.ts
    // explicitly excludes /api/runtime/*, so the per-router middleware is
    // the only thing standing between an unauthenticated request and the
    // log-deletion side effect.
    const { app } = createApp()
    const res = await app.request('/api/runtime/logs/prune', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
    // Hermetic guarantee: even if the auth check ever regressed, the
    // mock catches it. purgeOldDaemonLogs must never run for an
    // unauthenticated request.
    expect(mockPurgeOldDaemonLogs).not.toHaveBeenCalled()
  })

  it('allows POST /api/runtime/logs/prune with the bearer token', async () => {
    mockPurgeOldDaemonLogs.mockResolvedValueOnce({ removed: 2, retained: 5 })
    const { app } = createApp()
    const res = await app.request('/api/runtime/logs/prune', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ removed: 2, retained: 5 })
    expect(mockPurgeOldDaemonLogs).toHaveBeenCalledTimes(1)
  })
})

describe('daemon identity surfaces', () => {
  const NONCE = Buffer.from('0123456789abcdef').toString('base64url')

  it('ping advertises the identity public key', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/ping')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { identity?: { alg: string; publicKey: string } }
    expect(body.identity).toEqual({ alg: 'Ed25519', publicKey: testIdentity.publicKey })
  })

  it('verify answers an unauthenticated challenge with a signature binding nonce + origin', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://caller.example' },
      body: JSON.stringify({ nonce: NONCE }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { alg: string; publicKey: string; signature: string }
    expect(body.publicKey).toBe(testIdentity.publicKey)
    expect(
      verifyIdentitySignature(['wb-verify-v1', NONCE, 'https://caller.example'], body.signature),
    ).toBe(true)
    // A different origin's challenge must not verify with this signature.
    expect(
      verifyIdentitySignature(['wb-verify-v1', NONCE, 'https://other.example'], body.signature),
    ).toBe(false)
  })

  it('verify binds an ABSENT Origin header as the empty string', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: NONCE }),
    })
    const body = (await res.json()) as { signature: string }
    expect(verifyIdentitySignature(['wb-verify-v1', NONCE, ''], body.signature)).toBe(true)
  })

  it('verify rejects a malformed nonce', async () => {
    const { app } = createApp()
    for (const nonce of [
      '',
      'short',
      '!!!not-base64url!!!',
      Buffer.alloc(64).toString('base64url'),
    ]) {
      const res = await app.request('/api/runtime/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      })
      expect(res.status).toBe(400)
    }
  })

  it('verify rate-limits a tight loop with 429', async () => {
    const { app } = createApp()
    let limited = 0
    for (let i = 0; i < 70; i += 1) {
      const res = await app.request('/api/runtime/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: NONCE }),
      })
      if (res.status === 429) limited += 1
    }
    expect(limited).toBeGreaterThan(0)
  })
})
