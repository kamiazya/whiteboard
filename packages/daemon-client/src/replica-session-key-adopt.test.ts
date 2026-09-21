/**
 * The two halves of a cold start (ADR-0042 decision 6).
 *
 * A key the holder MINTED has to reach whoever will wrap it, and a key
 * someone unwrapped has to reach the holder — through the one parse a fetch
 * goes through, so a cold-started replica and a freshly-fetched one are the
 * same state rather than two shapes that agree today.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptSessionKey,
  forgetAll,
  type ReplicaSource,
  sessionKey,
  sessionKeyStatus,
} from './replica-session-key.js'

const DAEMON = 'https://daemon.example'
const WORKSPACE = 'ws-1'

const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

const RESPONSE = {
  workspaceKey: base64Url(WORKSPACE_KEY),
  workspaceKeySalt: base64Url(WORKSPACE_SALT),
  tier: 'offline' as const,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sourceWith(fetchImpl: typeof fetch, extra: Partial<ReplicaSource> = {}): ReplicaSource {
  return {
    fetch: fetchImpl,
    bindSession: async () => ({ ok: false as const, reason: 'no-passkey' as const }),
    ...extra,
  }
}

afterEach(() => {
  forgetAll()
})

describe('adoptSessionKey', () => {
  it('holds an unwrapped response as if it had been fetched, without any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(RESPONSE))

    expect(adoptSessionKey(DAEMON, WORKSPACE, RESPONSE)).toBe(true)

    // The whole point of a cold start: readable with the daemon unreachable.
    expect(await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))).toEqual({
      kind: 'key',
      workspaceKey: WORKSPACE_KEY,
      workspaceKeySalt: WORKSPACE_SALT,
      tier: 'offline',
      leaseExpiresAt: undefined,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports the adopted tier through the status a page reads', () => {
    adoptSessionKey(DAEMON, WORKSPACE, RESPONSE)

    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toEqual({ kind: 'held', tier: 'offline' })
  })

  it('refuses a lease that has already expired rather than holding a dead key', () => {
    // A `bounded` blob that outlived its lease is the ordinary case after a
    // laptop sleeps: adopting it would hold bytes every read then rejects.
    const expired = {
      ...RESPONSE,
      tier: 'bounded' as const,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }

    expect(adoptSessionKey(DAEMON, WORKSPACE, expired)).toBe(false)
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toBeUndefined()
  })

  it('does not displace a key this session already holds', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(RESPONSE))
    await sessionKey(DAEMON, WORKSPACE, sourceWith(fetchImpl))

    // A live session outranks a blob from disk, which may be older.
    expect(adoptSessionKey(DAEMON, WORKSPACE, { ...RESPONSE, tier: 'no-offline' as const })).toBe(
      false,
    )
    expect(sessionKeyStatus(DAEMON, WORKSPACE)).toEqual({ kind: 'held', tier: 'offline' })
  })
})

describe('ReplicaSource.onKeyResponse', () => {
  it('hands the minted response to the caller that will wrap it', async () => {
    const seen: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(RESPONSE))

    await sessionKey(
      DAEMON,
      WORKSPACE,
      sourceWith(fetchImpl, { onKeyResponse: (r) => seen.push(r) }),
    )

    // The PARSED response, so the wrapper seals exactly what a cold start
    // will parse back — not a re-serialisation of the decoded bytes.
    expect(seen).toEqual([RESPONSE])
  })

  it('says nothing when the daemon withholds the key', async () => {
    const seen: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'not_a_member' }, 403))

    await sessionKey(
      DAEMON,
      WORKSPACE,
      sourceWith(fetchImpl, { onKeyResponse: (r) => seen.push(r) }),
    )

    expect(seen).toEqual([])
  })
})
