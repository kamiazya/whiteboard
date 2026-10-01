import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  didKeyToEd25519PublicKey,
  ed25519PublicKeyToDidKey,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/did-key'
import { daemonPingResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CredentialResolverConfig,
  createCredentialResolver,
} from '../security/credential-resolver.js'
import { mintMacaroon } from '../security/macaroon.js'

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
vi.mock('../store/document-store.js', () => ({
  readLatestCompactedAt: () => mockReadLatestCompactedAt(),
}))
vi.mock('../../daemon/log-rotation.js', () => ({
  purgeOldDaemonLogs: (dir: string) => mockPurgeOldDaemonLogs(dir),
}))

const { createRuntimeRouter } = await import('./runtime.js')
const { createDaemonIdentity } = await import('../security/daemon-identity.js')

// Real identity in an isolated temp dir (injected — the router never touches
// the mocked config seam for it).
const identityDir = mkdtempSync(join(tmpdir(), 'wb-runtime-identity-'))
const testIdentity = createDaemonIdentity({ dataDir: identityDir })
process.once('exit', () => rmSync(identityDir, { recursive: true, force: true }))

// Credentials go through a REAL resolver rather than reaching the router as
// separate optional fields. That is the point of the refactor: these tests
// exercise the same component production does, so a branch that works here
// works there.
//
// Typed as the resolver's own config rather than `Partial<RouterOptions>`:
// the previous shape spread a Partial, which let a MISSING required option
// typecheck (TypeScript assumes the spread may supply it and drops excess
// property checks). Measured — the router ran without a resolver and every
// case answered 500.
function createApp(credentials: Omit<CredentialResolverConfig, 'daemonToken'> = {}) {
  const touch = vi.fn()
  const app = createRuntimeRouter({
    credentialResolver: createCredentialResolver({ daemonToken: 'secret', ...credentials }),
    instanceId: 'test-instance-id',
    identity: testIdentity,
    touch,
    getStatus: () => ({
      pid: 10,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 50,
      connectedClients: 2,
      readyClients: 1,
    }),
  })

  return { app, touch }
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
      identity: {
        alg: 'Ed25519',
        publicKey: testIdentity.publicKey,
        did: ed25519PublicKeyToDidKey(testIdentity.publicKey),
      },
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
      socketPath: '/run/user/1000/whiteboard/d.sock',
      connectedClients: 2,
      readyClients: 1,
    })
    expect(touch).toHaveBeenCalledTimes(1)
  })

  /**
   * The daemon is stopped by a SIGNAL, not over HTTP. `whiteboard daemon stop`
   * reads the pid and signals the process, and the idle timer calls `close()`
   * directly — so the route this replaces had no caller anywhere, while
   * presenting the one HTTP surface that could end the process.
   *
   * Asserted with the DAEMON TOKEN, the widest credential there is: a refusal
   * for a narrow one would not distinguish "route deleted" from "route
   * guarded".
   */
  it('serves no HTTP route that stops the daemon, not even to the daemon token', async () => {
    const { app } = createApp()

    const res = await app.request('/api/runtime/shutdown', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    })

    expect(res.status).not.toBe(200)
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
  it('ping advertises the identity public key', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/ping')
    expect(res.status).toBe(200)
    const body = daemonPingResponseSchema.parse(await res.json())
    expect(body.identity?.alg).toBe('Ed25519')
    expect(body.identity?.publicKey).toBe(testIdentity.publicKey)
  })

  // The did is a NAME for the key already advertised, not a second
  // credential (ADR-0035 decision 1). So the check that matters is that the
  // two agree: decoding the did has to give back the very bytes a pinning
  // browser would verify against, or the daemon is publishing two identities.
  it('ping names the same key as a did:key', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/ping')
    const body = daemonPingResponseSchema.parse(await res.json())
    const did = body.identity?.did
    expect(did).toMatch(/^did:key:z6Mk/)
    expect(didKeyToEd25519PublicKey(did as string)).toBe(testIdentity.publicKey)
    expect(did).toBe(ed25519PublicKeyToDidKey(testIdentity.publicKey))
  })
})

// What the unification FIXED, stated as a behaviour test rather than a claim.
//
// `/api/runtime/*` had its own credential branches — the daemon token, an
// OAuth grant and a pairing token — and no macaroon branch. The global
// `/api/*` gate already admitted a macaroon carrying the route's declared
// scope, so the two disagreed: the registry said `runtime:read` opens
// `/api/runtime/storage`, the outer gate agreed, and the inner one refused.
// Failing closed, so not a hole — but a feature that did not work where the
// registry said it did, with nothing red anywhere.
//
// It is not that the branch was forgotten once. It is that there was a place
// for it to be forgotten, four times over.
describe('runtime routes — a macaroon reaches the read half, like every other narrow credential', () => {
  const ROOT_KEY = new Uint8Array(32).fill(11)

  it('allows GET /api/runtime/storage with a macaroon caveated to runtime:read', async () => {
    const { app } = createApp({ macaroonRootKey: ROOT_KEY })
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['runtime:read'] }],
    })

    const res = await app.request('/api/runtime/storage', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
  })

  it('refuses a macaroon that does not carry runtime:read', async () => {
    const { app } = createApp({ macaroonRootKey: ROOT_KEY })
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const res = await app.request('/api/runtime/storage', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(401)
  })

  // The per-surface policy this router keeps, and the reason its check is not
  // just `hasRequiredScopes`: the admin half is daemon-token-only whatever
  // scopes a narrow credential holds — including `runtime:admin` itself.
  it('refuses a macaroon on POST /api/runtime/logs/prune, which is daemon-token-only in the handler', async () => {
    const { app } = createApp({ macaroonRootKey: ROOT_KEY })
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['runtime:admin', 'runtime:read'] }],
    })

    const res = await app.request('/api/runtime/logs/prune', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(401)
  })
})
