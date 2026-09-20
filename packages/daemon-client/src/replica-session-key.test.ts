import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveDocumentKey, openBytes, sealBytes } from './read-plane.js'
import {
  forget,
  forgetAll,
  type ReplicaSource,
  replicaKeyProviderFor,
  sessionKey,
  sessionKeyStatus,
} from './replica-session-key.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

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

  it('a 200 body that fails the response schema withholds as unreachable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tier: 'offline' }))
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(result).toEqual({ kind: 'withheld', reason: 'unreachable' })
  })

  it('a non-200 body that fails the refusal schema withholds as unreachable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ oops: 'not a refusal' }, 500))
    const result = await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(result).toEqual({ kind: 'withheld', reason: 'unreachable' })
  })

  it('a rejecting bindSession does not poison the cache — the next call retries instead of replaying the rejection', async () => {
    let fetchCalls = 0
    const fetchImpl = vi.fn(async () => {
      fetchCalls += 1
      // Every request starts by being told it needs a person session; only
      // the fetch that follows a successful bind (the 3rd overall) answers
      // with a key.
      return fetchCalls <= 2
        ? jsonResponse({ error: 'requires_person_session', message: 'not signed in' }, 403)
        : jsonResponse(keyResponse())
    })
    const bindSession = vi.fn<ReplicaSource['bindSession']>()
    bindSession.mockImplementationOnce(async () => {
      throw new Error('WebAuthn ceremony threw')
    })
    bindSession.mockImplementation(async () => ({ ok: true as const }))
    const source = sourceWith(fetchImpl, bindSession)

    await expect(sessionKey(DAEMON, WORKSPACE, source)).rejects.toThrow('WebAuthn ceremony threw')

    // Without the fix, the rejected promise stays in `inFlight` forever and
    // this second call would be handed the SAME rejected promise back.
    const second = await sessionKey(DAEMON, WORKSPACE, source)
    expect(second.kind).toBe('key')
    expect(bindSession).toHaveBeenCalledTimes(2)
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

  it('replicaKeyProviderFor re-derives after a natural lapse + re-mint, with no forget() in between', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const leaseExpiresAt = new Date('2026-01-01T01:00:00.000Z').toISOString()
    const fetchImpl1 = vi.fn(async () =>
      jsonResponse(keyResponse({ tier: 'bounded', leaseExpiresAt })),
    )
    const provider = replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl1))
    const first = await provider.keyFor('doc-1')
    expect(first).not.toBe('withheld')

    // Past the lease. The next `keyFor` mints fresh bytes with no explicit
    // forget() — the automatic lapse path is what must clear the memo.
    vi.setSystemTime(new Date('2026-01-01T01:00:01.000Z'))
    const otherWorkspaceKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    const fetchImpl2 = vi.fn(async () =>
      jsonResponse(
        keyResponse({
          workspaceKey: base64Url(otherWorkspaceKey),
          tier: 'bounded',
          leaseExpiresAt: new Date('2026-01-01T02:00:00.000Z').toISOString(),
        }),
      ),
    )
    const providerAfterLapse = replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl2))
    // The read immediately after lapse consumes the lapsed cache entry and
    // answers withheld:lapsed (documented behaviour, above); the next read
    // is what actually fetches and mints the fresh bytes.
    await providerAfterLapse.keyFor('doc-1')
    const second = await providerAfterLapse.keyFor('doc-1')
    expect(second).not.toBe('withheld')
    if (first === 'withheld' || second === 'withheld') return

    const context = { documentId: 'doc-1', epoch: 0 }
    const envelope = await sealBytes(first.key, new TextEncoder().encode('probe'), context)
    // If the lapse path failed to clear the memo, `second.key` would be the
    // SAME memoized CryptoKey derived from the pre-lapse workspace key, and
    // this would open cleanly instead of failing.
    await expect(openBytes(second.key, envelope, context)).rejects.toMatchObject({
      name: 'OperationError',
    })
  })
})

describe('replica-session-key: sessionKeyStatus', () => {
  afterEach(() => {
    forgetAll()
    vi.useRealTimers()
  })

  it('answers undefined before any ask, and issues no request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(keyResponse()))
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers held+tier after a key, withheld+reason after a refusal, and undefined after forget', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(keyResponse({ tier: 'offline' })))
    await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toEqual({ kind: 'held', tier: 'offline' })

    const refusalFetch = vi.fn(async () =>
      jsonResponse({ error: 'not_a_member', message: 'x' }, 403),
    )
    await sessionKey(DAEMON, 'ws-2', sourceWith(refusalFetch))
    expect(sessionKeyStatus(DAEMON, 'ws-2')).toEqual({ kind: 'withheld', reason: 'not_a_member' })

    forget(DAEMON, WORKSPACE)
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toBeUndefined()
    // A status read never triggers a network request of its own.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(refusalFetch).toHaveBeenCalledTimes(1)
  })

  it('reports lapsed for a bounded lease past its own expiry, agreeing with sessionKey on the same clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const leaseExpiresAt = new Date('2026-01-01T01:00:00.000Z').toISOString()
    const fetchImpl = vi.fn(async () =>
      jsonResponse(keyResponse({ tier: 'bounded', leaseExpiresAt })),
    )
    await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toEqual({
      kind: 'held',
      tier: 'bounded',
      leaseExpiresAt: Date.parse(leaseExpiresAt),
    })

    vi.setSystemTime(new Date('2026-01-01T01:00:01.000Z'))
    // A status read is side-effect-free: checking twice answers the same
    // both times, rather than the first purging the cache out from under
    // the second (which is what `sessionKey`'s own lapse check does).
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toEqual({ kind: 'withheld', reason: 'lapsed' })
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toEqual({ kind: 'withheld', reason: 'lapsed' })
    const afterViaSessionKey = await sessionKey(DAEMON, WORKSPACE)
    expect(afterViaSessionKey).toEqual({ kind: 'withheld', reason: 'lapsed' })
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

  it('forget() while a request is outstanding starts a fresh one, and the stale settlement does not resurrect the forgotten entry', async () => {
    let resolveStale: (r: Response) => void = () => {}
    let fetchCalls = 0
    const fetchImpl = vi.fn(() => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return new Promise<Response>((resolve) => {
          resolveStale = resolve
        })
      }
      return Promise.resolve(jsonResponse(keyResponse({ tier: 'no-offline' })))
    })
    const source = sourceWith(fetchImpl)

    const stale = sessionKey(DAEMON, WORKSPACE, source)
    forget(DAEMON, WORKSPACE)
    const fresh = await sessionKey(DAEMON, WORKSPACE, source)
    expect(fresh.kind).toBe('key')
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // The forgotten request finally settles; it must not overwrite what the
    // fresh request just cached.
    resolveStale(jsonResponse(keyResponse({ tier: 'offline' })))
    await stale
    const readBack = await sessionKey(DAEMON, WORKSPACE, source)
    expect(readBack).toEqual(fresh)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
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

  it('forget() clears the derived-key memo — a later session key derives a functionally different CryptoKey', async () => {
    const fetchImpl1 = vi.fn(async () => jsonResponse(keyResponse()))
    const first = await replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl1)).keyFor(
      'doc-1',
    )
    expect(first).not.toBe('withheld')

    forget(DAEMON, WORKSPACE)

    const otherWorkspaceKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    const fetchImpl2 = vi.fn(async () =>
      jsonResponse(keyResponse({ workspaceKey: base64Url(otherWorkspaceKey) })),
    )
    const second = await replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl2)).keyFor(
      'doc-1',
    )
    expect(second).not.toBe('withheld')
    if (first === 'withheld' || second === 'withheld') return

    const context = { documentId: 'doc-1', epoch: 0 }
    const envelope = await sealBytes(first.key, new TextEncoder().encode('probe'), context)
    // If forget() failed to clear the memo, `second.key` would be the SAME
    // memoized CryptoKey as `first.key` and this would open cleanly.
    await expect(openBytes(second.key, envelope, context)).rejects.toMatchObject({
      name: 'OperationError',
    })
  })

  it('forget() during an in-flight keyFor answers withheld and leaves no derived-key memo behind', async () => {
    let resolveStale: (r: Response) => void = () => {}
    const otherWorkspaceKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    let fetchCalls = 0
    const fetchImpl = vi.fn(() => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return new Promise<Response>((resolve) => {
          resolveStale = resolve
        })
      }
      return Promise.resolve(
        jsonResponse(keyResponse({ workspaceKey: base64Url(otherWorkspaceKey) })),
      )
    })
    const provider = replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl))

    const stale = provider.keyFor('doc-1')
    forget(DAEMON, WORKSPACE)
    resolveStale(jsonResponse(keyResponse()))
    expect(await stale).toBe('withheld')

    // The next ask goes through a fresh request and derives from ITS bytes;
    // a resurrected memo would answer with a key derived from the forgotten ones.
    const fresh = await provider.keyFor('doc-1')
    expect(fresh).not.toBe('withheld')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    if (fresh === 'withheld') return
    const expected = await deriveDocumentKey({
      workspaceKey: otherWorkspaceKey,
      workspaceKeySalt: WORKSPACE_SALT,
      documentId: 'doc-1',
      epoch: 0,
    })
    const context = { documentId: 'doc-1', epoch: 0 }
    const envelope = await sealBytes(expected, new TextEncoder().encode('probe'), context)
    expect(new TextDecoder().decode(await openBytes(fresh.key, envelope, context))).toBe('probe')
  })

  it('forgetAll() clears the derived-key memo too', async () => {
    const fetchImpl1 = vi.fn(async () => jsonResponse(keyResponse()))
    const first = await replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl1)).keyFor(
      'doc-1',
    )
    expect(first).not.toBe('withheld')

    forgetAll()

    const otherWorkspaceKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    const fetchImpl2 = vi.fn(async () =>
      jsonResponse(keyResponse({ workspaceKey: base64Url(otherWorkspaceKey) })),
    )
    const second = await replicaKeyProviderFor(DAEMON, WORKSPACE, sourceWith(fetchImpl2)).keyFor(
      'doc-1',
    )
    expect(second).not.toBe('withheld')
    if (first === 'withheld' || second === 'withheld') return

    const context = { documentId: 'doc-1', epoch: 0 }
    const envelope = await sealBytes(first.key, new TextEncoder().encode('probe'), context)
    await expect(openBytes(second.key, envelope, context)).rejects.toMatchObject({
      name: 'OperationError',
    })
  })
})

describe('replica-session-key: property — TTL boundary and concurrent dedup', () => {
  afterEach(() => {
    forgetAll()
    vi.useRealTimers()
  })

  fcTest.prop(
    [fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: -2000, max: 2000 })],
    withDefaults({ numRuns: 30 }),
  )(
    'a bounded lease answers the minted key strictly before leaseExpiresAt and withheld:lapsed at or after it, for any lease length and probe offset',
    async (leaseMs, offsetMs) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const start = Date.UTC(2026, 0, 1)
        vi.setSystemTime(new Date(start))
        const leaseExpiresAtMs = start + leaseMs
        const fetchImpl = vi.fn(async () =>
          jsonResponse(
            keyResponse({
              tier: 'bounded',
              leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
            }),
          ),
        )
        const source = sourceWith(fetchImpl)
        // A fresh (daemon, workspace) pair per run — the module-singleton
        // cache otherwise leaks between fast-check iterations of one test.
        const daemon = `${DAEMON}/ttl-${leaseMs}-${offsetMs}`

        const minted = await sessionKey(daemon, WORKSPACE, source)
        expect(minted.kind).toBe('key')

        vi.setSystemTime(new Date(leaseExpiresAtMs + offsetMs))
        const probed = await sessionKey(daemon, WORKSPACE, source)
        if (offsetMs < 0) {
          expect(probed).toEqual(minted)
        } else {
          expect(probed).toEqual({ kind: 'withheld', reason: 'lapsed' })
        }
        expect(fetchImpl).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  let dedupRun = 0
  fcTest.prop([fc.integer({ min: 2, max: 6 })], withDefaults({ numRuns: 20 }))(
    'N concurrent calls for one (daemon, workspace) pair share exactly one in-flight fetch and all resolve to the identical result',
    async (n) => {
      dedupRun += 1
      let resolveFetch: (r: Response) => void = () => {}
      const fetchImpl = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          }),
      )
      const source = sourceWith(fetchImpl)
      // A fresh (daemon, workspace) pair per run, same reason as the TTL
      // property above.
      const daemon = `${DAEMON}/dedup-${dedupRun}`

      const calls = Array.from({ length: n }, () => sessionKey(daemon, WORKSPACE, source))
      resolveFetch(jsonResponse(keyResponse()))
      const results = await Promise.all(calls)

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      for (const result of results) {
        expect(result).toEqual(results[0])
      }
    },
  )
})
