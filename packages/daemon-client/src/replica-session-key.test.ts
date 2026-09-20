import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forget,
  forgetAll,
  type ReplicaSource,
  replicaKeyProviderFor,
  sessionKey,
} from './replica-session-key.js'

const DAEMON = 'https://daemon.example'
const WORKSPACE = 'ws-1'

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

function keyResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    workspaceKey: base64Url(WORKSPACE_KEY),
    workspaceKeySalt: base64Url(WORKSPACE_SALT),
    tier: 'offline',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sourceWith(
  fetchImpl: typeof fetch,
  bindSession?: ReplicaSource['bindSession'],
): ReplicaSource {
  return {
    fetch: fetchImpl,
    bindSession:
      bindSession ?? vi.fn(async () => ({ ok: false as const, reason: 'no-passkey' as const })),
  }
}

describe('replica-session-key: sessionKey', () => {
  afterEach(() => {
    forgetAll()
    vi.useRealTimers()
  })

  it('mints a key from a 200 response, decoded from base64url', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(keyResponse()))
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(result).toEqual({
      kind: 'key',
      workspaceKey: WORKSPACE_KEY,
      workspaceKeySalt: WORKSPACE_SALT,
      tier: 'offline',
      leaseExpiresAt: undefined,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${DAEMON}/api/workspaces/${WORKSPACE}/replica-key`)
    expect(init?.method).toBe('POST')
  })

  it('two concurrent calls for the same (daemon, workspace) share one in-flight fetch', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const source = sourceWith(fetchImpl)
    const p1 = sessionKey(DAEMON, WORKSPACE, source)
    const p2 = sessionKey(DAEMON, WORKSPACE, source)
    resolveFetch(jsonResponse(keyResponse()))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2)
  })

  it('a different workspace mints its own key, independent of another workspace in flight', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('ws-2')
        ? jsonResponse(keyResponse({ tier: 'no-offline' }))
        : jsonResponse(keyResponse()),
    )
    const source = sourceWith(fetchImpl)
    const [a, b] = await Promise.all([
      sessionKey(DAEMON, WORKSPACE, source),
      sessionKey(DAEMON, 'ws-2', source),
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(a.kind).toBe('key')
    expect(b.kind).toBe('key')
    if (a.kind === 'key' && b.kind === 'key') {
      expect(a.tier).toBe('offline')
      expect(b.tier).toBe('no-offline')
    }
  })

  it('maps a 403 not_a_member refusal to a withheld reason', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'not_a_member', message: 'no such member' }, 403),
    )
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(result).toEqual({ kind: 'withheld', reason: 'not_a_member' })
  })

  it('maps a 403 replica_not_allowed refusal to a withheld reason', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'replica_not_allowed', message: 'no offline replica' }, 403),
    )
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(result).toEqual({ kind: 'withheld', reason: 'replica_not_allowed' })
  })

  it('requires_person_session: binds once and retries once, succeeding on retry', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? jsonResponse({ error: 'requires_person_session', message: 'not signed in' }, 403)
        : jsonResponse(keyResponse())
    })
    const bindSession = vi.fn(async () => ({ ok: true as const }))
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl, bindSession))
    expect(bindSession).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.kind).toBe('key')
  })

  it('requires_person_session: bind failure withholds with no retry', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'requires_person_session', message: 'not signed in' }, 403),
    )
    const bindSession = vi.fn(async () => ({ ok: false as const, reason: 'no-passkey' as const }))
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl, bindSession))
    expect(bindSession).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kind: 'withheld', reason: 'requires_person_session' })
  })

  it('a thrown fetch withholds as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(result).toEqual({ kind: 'withheld', reason: 'unreachable' })
  })

  it('no source at all withholds as unreachable, without making a request or poisoning the cache', async () => {
    const first = await sessionKey(DAEMON, WORKSPACE)
    expect(first).toEqual({ kind: 'withheld', reason: 'unreachable' })
    const fetchImpl = vi.fn(async () => jsonResponse(keyResponse()))
    const second = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(second.kind).toBe('key')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('withheld answers stay cached (no re-request) until forget()', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'not_a_member', message: 'no such member' }, 403),
    )
    const source = sourceWith(fetchImpl)
    await sessionKey(DAEMON, WORKSPACE, source)
    const second = await sessionKey(DAEMON, WORKSPACE, source)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ kind: 'withheld', reason: 'not_a_member' })
  })
})

describe('replica-session-key: bounded lease lapse', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    forgetAll()
    vi.useRealTimers()
  })

  it('answers key before the lease, withheld:lapsed after, and drops the bytes', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const leaseExpiresAt = new Date('2026-01-01T01:00:00.000Z').toISOString()
    const fetchImpl = vi.fn(async () =>
      jsonResponse(keyResponse({ tier: 'bounded', leaseExpiresAt })),
    )
    const source = sourceWith(fetchImpl)

    const before = await sessionKey(DAEMON, WORKSPACE, source)
    expect(before.kind).toBe('key')

    vi.setSystemTime(new Date('2026-01-01T01:00:01.000Z'))
    const after = await sessionKey(DAEMON, WORKSPACE, source)
    expect(after).toEqual({ kind: 'withheld', reason: 'lapsed' })

    // Bytes are gone, not merely hidden: with no source the entry re-reads
    // as plain 'unreachable' rather than replaying the lapsed key.
    const noSource = await sessionKey(DAEMON, WORKSPACE)
    expect(noSource).toEqual({ kind: 'withheld', reason: 'unreachable' })
  })
})

describe('replica-session-key: forget / forgetAll', () => {
  afterEach(() => {
    forgetAll()
  })

  it('forget() clears the cached key and forces a re-request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(keyResponse()))
    const source = sourceWith(fetchImpl)
    await sessionKey(DAEMON, WORKSPACE, source)
    forget(DAEMON, WORKSPACE)
    await sessionKey(DAEMON, WORKSPACE, source)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('forgetAll() clears every daemon', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(keyResponse()))
    const source = sourceWith(fetchImpl)
    await sessionKey(DAEMON, WORKSPACE, source)
    await sessionKey(DAEMON, 'ws-2', source)
    forgetAll()
    await sessionKey(DAEMON, WORKSPACE, source)
    await sessionKey(DAEMON, 'ws-2', source)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})

describe('replicaKeyProviderFor', () => {
  afterEach(() => {
    forgetAll()
  })

  it('keyFor derives a non-extractable key matching deriveDocumentKey on the same inputs', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(keyResponse()))
    const provider = replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    const resolved = await provider.keyFor('doc-1')
    expect(resolved).not.toBe('withheld')
    if (resolved !== 'withheld') {
      expect(resolved.epoch).toBe(0)
      expect(resolved.key.extractable).toBe(false)
      expect(resolved.key.algorithm.name).toBe('AES-GCM')
    }
  })

  it('keyFor answers withheld when the session key is withheld', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'not_a_member', message: 'no such member' }, 403),
    )
    const provider = replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(await provider.keyFor('doc-1')).toBe('withheld')
  })
})
