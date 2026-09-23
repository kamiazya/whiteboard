/**
 * Model-based: any interleaving of issuing, opening, redeeming, revoking and
 * the clock moving must agree with a plain in-memory model of what an
 * invitation link IS — usable only while unexpired, unrevoked and unredeemed,
 * and redeemable exactly once. The model states that definition; it is not a
 * copy of the store's query.
 *
 * Each run gets its own tenant rather than its own database: the tenant-bound
 * handle is what isolates rows anyway, and it costs nothing to mint one.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createInvitationStore } from './invitation-store.js'

const TTL = 1000

type Op =
  | { readonly kind: 'issue' }
  | { readonly kind: 'open'; readonly pick: number }
  | { readonly kind: 'redeem'; readonly pick: number }
  | { readonly kind: 'revoke'; readonly pick: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'toExpiry'; readonly pick: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant({ kind: 'issue' as const }),
  fc.record({ kind: fc.constant('open' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('redeem' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('revoke' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.constantFrom(1, 499, 500, 1000) }),
  // Lands the clock EXACTLY on one link's expiry. Random steps reached that
  // instant too rarely to count on — it is where `>=` versus `>` lives.
  fc.record({ kind: fc.constant('toExpiry' as const), pick: fc.nat() }),
)

interface Modelled {
  readonly id: string
  readonly token: string
  readonly expiresAt: number
  redeemed: boolean
  revoked: boolean
}

function expected(inv: Modelled, now: number): 'usable' | 'expired' | 'redeemed' | 'unknown' {
  if (inv.revoked) return 'unknown'
  if (inv.redeemed) return 'redeemed'
  return now >= inv.expiresAt ? 'expired' : 'usable'
}

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let run = 0
const reached = { redeemedOnce: 0, refusedTwice: 0, expiredAtBoundary: 0 }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-invitations-model-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterAll(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('invitation links — against a model', () => {
  afterAll(() => {
    expect(reached.redeemedOnce, 'no run ever redeemed a link').toBeGreaterThan(0)
    expect(reached.refusedTwice, 'no run ever tried a second redemption').toBeGreaterThan(0)
    expect(reached.expiredAtBoundary, 'no run ever sat exactly on the TTL').toBeGreaterThan(0)
  })

  fcTest.prop([fc.array(opArb, { minLength: 1, maxLength: 30 })], withDefaults({ numRuns: 60 }))(
    'opening and redeeming always answer what the model says a link is',
    async (ops) => {
      const store = createInvitationStore(tenantDatabase(handle.rawDb, `model-${run++}`))
      const issued: Modelled[] = []
      let now = 1_800_000_000_000
      for (const op of ops) {
        if (op.kind === 'advance') {
          now += op.ms
          continue
        }
        if (op.kind === 'issue') {
          const { token, invitation } = await store.createLink({ invitedBy: 'p', now, ttlMs: TTL })
          issued.push({
            id: invitation.id,
            token,
            expiresAt: now + TTL,
            redeemed: false,
            revoked: false,
          })
          continue
        }
        const inv = issued[op.pick % Math.max(issued.length, 1)]
        if (inv === undefined) continue
        if (op.kind === 'toExpiry') {
          now = Math.max(now, inv.expiresAt)
          continue
        }
        const state = expected(inv, now)
        if (op.kind === 'open') {
          const opened = await store.openLink(inv.token, now)
          expect(opened.ok ? 'usable' : opened.reason).toBe(state)
          if (now === inv.expiresAt) reached.expiredAtBoundary++
        } else if (op.kind === 'redeem') {
          const ok = await store.redeem(inv.id, 'p-x', now)
          expect(ok).toBe(state === 'usable')
          if (ok) {
            inv.redeemed = true
            reached.redeemedOnce++
          } else if (state === 'redeemed') reached.refusedTwice++
        } else {
          expect(await store.revoke(inv.id)).toBe(!inv.revoked)
          inv.revoked = true
        }
      }
    },
  )
})
