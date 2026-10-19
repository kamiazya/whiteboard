import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../../shared/sha256.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createSignInAttemptStore, type SignInAttemptStore } from './sign-in-attempt-store.js'

const T0 = 1_800_000_000_000
const TTL = 10 * 60 * 1000
const PEER = '192.0.2.10'

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
      source: PEER,
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
    const begun = await attempts.begin({
      providerId: 'corp',
      returnTo: '/',
      source: PEER,
      now: T0,
      ttlMs: TTL,
    })
    await attempts.take(begun.state, 'another-browser', T0 + 1)
    expect(await attempts.take(begun.state, begun.browserBinding, T0 + 2)).not.toBeNull()
  })

  it('does not hand back an expired attempt', async () => {
    const begun = await attempts.begin({
      providerId: 'corp',
      returnTo: '/',
      source: PEER,
      now: T0,
      ttlMs: TTL,
    })
    expect(await attempts.take(begun.state, begun.browserBinding, T0 + TTL)).toBeNull()
  })

  it('deletes abandoned attempts when a new one begins', async () => {
    await attempts.begin({ providerId: 'corp', returnTo: '/', source: PEER, now: T0, ttlMs: TTL })
    await attempts.begin({
      providerId: 'corp',
      returnTo: '/',
      source: PEER,
      now: T0 + TTL,
      ttlMs: TTL,
    })
    const rows = await handle.rawDb.selectFrom('signInAttempts').selectAll().execute()
    expect(rows).toHaveLength(1)
  })

  // The invitation store keeps only a token's hash, so an attempt holding
  // the token itself would be the one place a live link could be read back.
  it('carries the invitation a newcomer arrived with as its hash alone', async () => {
    const token = 'inv-token-that-must-not-be-stored'
    const begun = await attempts.begin({
      providerId: 'corp',
      returnTo: '/',
      invitationToken: token,
      source: PEER,
      now: T0,
      ttlMs: TTL,
    })
    const rows = await handle.rawDb.selectFrom('signInAttempts').selectAll().execute()
    expect(JSON.stringify(rows)).not.toContain(token)
    const taken = await attempts.take(begun.state, begun.browserBinding, T0 + 1)
    expect(taken?.invitationTokenHash).toBe(sha256Hex(token))
  })

  // Beginning needs no credential, so a flood must not grow the table without
  // bound; the OLDEST attempt goes, so a sign-in begun just now still lands.
  it('keeps no more than its ceiling of attempts, shedding the oldest', async () => {
    const capped = createSignInAttemptStore(handle.db, { maxPending: 3 })
    const begun = []
    for (let i = 0; i < 6; i++) {
      begun.push(
        await capped.begin({
          providerId: 'corp',
          returnTo: '/',
          source: PEER,
          now: T0 + i,
          ttlMs: TTL,
        }),
      )
    }
    const rows = await handle.rawDb.selectFrom('signInAttempts').selectAll().execute()
    expect(rows.length).toBeLessThanOrEqual(3)
    const newest = begun.at(-1)
    expect(newest).toBeDefined()
    expect(
      await capped.take(newest?.state ?? '', newest?.browserBinding ?? '', T0 + 7),
    ).not.toBeNull()
    const oldest = begun[0]
    expect(await capped.take(oldest?.state ?? '', oldest?.browserBinding ?? '', T0 + 7)).toBeNull()
  })

  // The ceiling holds against a flood, but what a full table sheds is the
  // flooding client's own attempts: beginning needs no credential, so evicting
  // the oldest overall would let one source end everybody else's sign-in.
  describe('when one source floods the ceiling', () => {
    const victimBegins = (store: SignInAttemptStore, source: string) =>
      store.begin({ providerId: 'corp', returnTo: '/', source, now: T0, ttlMs: TTL })
    const flood = async (store: SignInAttemptStore, sourceOf: (i: number) => string) => {
      for (let i = 1; i <= 40; i++) {
        await store.begin({
          providerId: 'corp',
          returnTo: '/',
          source: sourceOf(i),
          now: T0 + i,
          ttlMs: TTL,
        })
      }
    }

    it('keeps another source’s attempt and still holds the ceiling', async () => {
      const capped = createSignInAttemptStore(handle.db, { maxPending: 10 })
      const victim = await victimBegins(capped, '203.0.113.7')
      await flood(capped, () => '198.51.100.9')
      const rows = await handle.rawDb.selectFrom('signInAttempts').selectAll().execute()
      expect(rows.length).toBeLessThanOrEqual(10)
      expect(await capped.take(victim.state, victim.browserBinding, T0 + 50)).not.toBeNull()
    })

    // One IPv6 subscriber is routinely handed a whole /64, so addresses
    // inside it are one source rather than 2^64 of them.
    it('counts every address in one IPv6 /64 as one source', async () => {
      const capped = createSignInAttemptStore(handle.db, { maxPending: 10 })
      const victim = await victimBegins(capped, '2001:db8:1::5')
      await flood(capped, (i) => `2001:db8:2::${i.toString(16)}`)
      expect(await capped.take(victim.state, victim.browserBinding, T0 + 50)).not.toBeNull()
    })

    // One end-site /48 holds 65,536 /64s, so a flood spread one attempt per
    // /64 is still one allocation, and its attempts are the ones that go.
    it('sheds a flood spread across the /64s of one /48 before anyone else', async () => {
      const capped = createSignInAttemptStore(handle.db, { maxPending: 10 })
      await flood(capped, (i) => `2001:db8:7:${i.toString(16)}::1`)
      const victim = await capped.begin({
        providerId: 'corp',
        returnTo: '/',
        source: '203.0.113.7',
        now: T0 + 41,
        ttlMs: TTL,
      })
      for (let i = 41; i <= 80; i++) {
        await capped.begin({
          providerId: 'corp',
          returnTo: '/',
          source: `2001:db8:7:${i.toString(16)}::1`,
          now: T0 + 41 + i,
          ttlMs: TTL,
        })
      }
      const rows = await handle.rawDb.selectFrom('signInAttempts').selectAll().execute()
      expect(rows.length).toBeLessThanOrEqual(10)
      expect(await capped.take(victim.state, victim.browserBinding, T0 + 200)).not.toBeNull()
    })

    // Inside the heaviest /48 the heaviest /56 goes first, so a neighbour
    // sharing the site with a flooding /56 keeps its attempt.
    it('sheds the heaviest /56 inside the heaviest /48', async () => {
      const capped = createSignInAttemptStore(handle.db, { maxPending: 10 })
      const neighbour = await victimBegins(capped, '2001:db8:7:100::1')
      await flood(capped, (i) => `2001:db8:7:${i.toString(16)}::1`)
      expect(await capped.take(neighbour.state, neighbour.browserBinding, T0 + 50)).not.toBeNull()
    })

    // Concurrent begins each count the table before any of them inserts, so
    // unless room-making and the insert are one step, a burst overshoots the
    // ceiling and the next burst sheds far more than it adds — down past the
    // flooding source's own attempts to everybody else's.
    it('sheds at most one attempt per begin under a concurrent flood', async () => {
      const maxPending = 10
      const capped = createSignInAttemptStore(handle.db, { maxPending })
      const flooder = '198.51.100.9'
      for (let i = 0; i < maxPending; i++) {
        await capped.begin({
          providerId: 'corp',
          returnTo: '/',
          source: flooder,
          now: T0 + i,
          ttlMs: TTL,
        })
      }
      const victim = await capped.begin({
        providerId: 'corp',
        returnTo: '/',
        source: '203.0.113.7',
        now: T0 + maxPending,
        ttlMs: TTL,
      })
      const pending = async () =>
        (await handle.rawDb.selectFrom('signInAttempts').select('state').execute()).length
      for (let burst = 1; burst <= 2; burst++) {
        await Promise.all(
          Array.from({ length: 2 * maxPending }, (_, i) =>
            capped.begin({
              providerId: 'corp',
              returnTo: '/',
              source: flooder,
              now: T0 + 100 * burst + i,
              ttlMs: TTL,
            }),
          ),
        )
        expect(await pending()).toBe(maxPending)
      }
      expect(await capped.take(victim.state, victim.browserBinding, T0 + 1000)).not.toBeNull()
    })

    it('counts an IPv4-mapped IPv6 address as its IPv4 address', async () => {
      for (const source of ['198.51.100.9', '::ffff:198.51.100.9', '::ffff:c633:6409']) {
        await victimBegins(attempts, source)
      }
      await victimBegins(attempts, '198.51.100.10')
      const rows = await handle.rawDb.selectFrom('signInAttempts').select('source').execute()
      expect(new Set(rows.map((row) => row.source)).size).toBe(2)
    })

    it('never stores the client address itself', async () => {
      await victimBegins(attempts, '203.0.113.7')
      const rows = await handle.rawDb.selectFrom('signInAttempts').selectAll().execute()
      expect(JSON.stringify(rows)).not.toContain('203.0.113.7')
    })
  })
})
