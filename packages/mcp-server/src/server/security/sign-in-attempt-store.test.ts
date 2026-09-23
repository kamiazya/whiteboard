import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createSignInAttemptStore, type SignInAttemptStore } from './sign-in-attempt-store.js'

const T0 = 1_800_000_000_000
const TTL = 10 * 60 * 1000

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let attempts: SignInAttemptStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-sign-in-attempts-'))
  handle = await createIsolatedDb({ dataDir: root })
  attempts = createSignInAttemptStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('sign-in attempts', () => {
  it('hands the attempt back once, to the browser that began it', async () => {
    const begun = await attempts.begin({
      providerId: 'corp',
      returnTo: '/w/1',
      now: T0,
      ttlMs: TTL,
    })
    expect(await attempts.take(begun.state, 'another-browser', T0 + 1)).toBeNull()
    const taken = await attempts.take(begun.state, begun.browserBinding, T0 + 1)
    expect(taken).toMatchObject({ providerId: 'corp', returnTo: '/w/1', nonce: begun.nonce })
    expect(taken?.codeVerifier).toBe(begun.codeVerifier)
    expect(await attempts.take(begun.state, begun.browserBinding, T0 + 2)).toBeNull()
  })

  // A mismatched browser must not burn the attempt for its rightful owner.
  it('keeps the attempt for its owner when another browser presents the state', async () => {
    const begun = await attempts.begin({ providerId: 'corp', returnTo: '/', now: T0, ttlMs: TTL })
    await attempts.take(begun.state, 'another-browser', T0 + 1)
    expect(await attempts.take(begun.state, begun.browserBinding, T0 + 2)).not.toBeNull()
  })

  it('does not hand back an expired attempt', async () => {
    const begun = await attempts.begin({ providerId: 'corp', returnTo: '/', now: T0, ttlMs: TTL })
    expect(await attempts.take(begun.state, begun.browserBinding, T0 + TTL)).toBeNull()
  })

  it('carries the invitation a newcomer arrived with', async () => {
    const begun = await attempts.begin({
      providerId: 'corp',
      returnTo: '/',
      invitationToken: 'inv-token',
      now: T0,
      ttlMs: TTL,
    })
    const taken = await attempts.take(begun.state, begun.browserBinding, T0 + 1)
    expect(taken?.invitationToken).toBe('inv-token')
  })
})
