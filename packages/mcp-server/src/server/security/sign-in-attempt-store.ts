/**
 * ADR-0046 decision 1: an authorization-code flow in flight. `begin` mints
 * the state, nonce, PKCE verifier and a browser binding (which the route sets
 * as a host-only cookie); `take` hands them back exactly once, and only to
 * the browser that began the attempt.
 */
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { sha256Hex } from '../../shared/sha256.js'
import {
  inTenantTransaction,
  type TenantDatabase,
  type TenantScoped,
} from '../store/db/tenant-database.js'

interface BeginInput {
  readonly providerId: string
  readonly returnTo: string
  readonly invitationToken?: string
  /** The attempt asks the provider for a sign-in made now. */
  readonly fresh?: boolean
  /** The client's network address, when the transport knows it. */
  readonly source: string | undefined
  readonly now: number
  readonly ttlMs: number
}

interface Attempt {
  readonly providerId: string
  readonly nonce: string
  readonly codeVerifier: string
  /** The hash of the invitation token the attempt began with: what the invitation store keys by. */
  readonly invitationTokenHash: string | null
  readonly returnTo: string
  readonly fresh: boolean
}

export interface SignInAttemptStore {
  begin(input: BeginInput): Promise<Attempt & { state: string; browserBinding: string }>
  take(state: string, browserBinding: string, now: number): Promise<Attempt | null>
}

interface SignInAttemptStoreOptions {
  /** The most attempts kept in flight for one tenant at once. */
  readonly maxPending?: number
}

// Beginning an attempt needs no credential, so without a ceiling a flood of
// begins grows the table for as long as it lasts. When full, an attempt goes
// rather than the new one being refused — refusing would let a flood of this
// size every ten minutes lock everybody out of signing in — and the one that
// goes is the oldest of the SOURCE holding the most (judged by allocation,
// coarsest first), so a flood from one client sheds its own attempts and
// leaves everybody else's standing. The returnTo and invitation the route
// stores are both bounded, so a full table is a few tens of megabytes at most.
const DEFAULT_MAX_PENDING = 10_000

const random = () => randomBytes(32).toString('base64url')

// The eight 16-bit groups of an IPv6 address, after the URL parser has put it
// in canonical form (dotted IPv4 tails become hex groups).
function ipv6Groups(address: string): readonly string[] | null {
  const host = URL.parse(`http://[${address}]/`)?.hostname.slice(1, -1)
  if (host === undefined) return null
  const [head = '', tail] = host.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map((g) => g.padStart(4, '0'))
}

interface SourceKeys {
  readonly sourcePrefix48: string
  readonly sourcePrefix56: string
  readonly source: string
}

// What counts as one client, and the allocations it sits in. An IPv6
// subscriber is routinely handed a whole /64, and an end site a /56 or a /48
// (RFC 6177), so a single site holds up to 65,536 /64s; those three prefixes
// are its levels. An IPv4 address is scarce enough that each one is already a
// cost to an attacker, and a /24 is routinely shared by unrelated people (a
// carrier pool, a campus), so grouping by it would shed honest neighbours
// with a flood: an IPv4 source is its own address at every level. An
// IPv4-mapped address is its IPv4 one. Behind a reverse proxy every client
// shares the proxy's address and this degrades to one source, which is
// exactly the shedding a single ceiling did.
function sourceKeys(address: string | undefined): SourceKeys {
  const groups = address !== undefined && isIP(address) === 6 ? ipv6Groups(address) : null
  if (groups === null) return sameAtEveryLevel(address ?? '')
  if (groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff') {
    const [hi = 0, lo = 0] = [groups[6], groups[7]].map((g) => Number.parseInt(g ?? '0', 16))
    return sameAtEveryLevel([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'))
  }
  const site = groups.slice(0, 3).join(':')
  return {
    sourcePrefix48: sha256Hex(`${site}::/48`),
    sourcePrefix56: sha256Hex(`${site}:${(groups[3] ?? '').slice(0, 2)}00::/56`),
    source: sha256Hex(`${groups.slice(0, 4).join(':')}::/64`),
  }
}

function sameAtEveryLevel(key: string): SourceKeys {
  const digest = sha256Hex(key)
  return { sourcePrefix48: digest, sourcePrefix56: digest, source: digest }
}

// Coarsest first: the heaviest /48 is chosen, then the heaviest /56 inside
// it, then the heaviest /64 inside that, so spreading a flood across finer
// prefixes never moves the eviction off the allocation that holds them.
const SOURCE_LEVELS = ['sourcePrefix48', 'sourcePrefix56', 'source'] as const

// The attempt a full table sheds: the oldest of the heaviest source, found
// level by level (the oldest such group on a tie).
async function evictionCandidate(db: TenantScoped): Promise<{ state: string } | undefined> {
  let scope = db.selectFrom('signInAttempts')
  for (const level of SOURCE_LEVELS) {
    const heaviest = await scope
      .select(level)
      .groupBy(level)
      .orderBy((eb) => eb.fn.countAll(), 'desc')
      .orderBy((eb) => eb.fn.min('expiresAt'), 'asc')
      .limit(1)
      .executeTakeFirst()
    if (heaviest === undefined) return undefined
    scope = scope.where(level, '=', heaviest[level])
  }
  return scope.select('state').orderBy('expiresAt', 'asc').limit(1).executeTakeFirst()
}

// Leaves room for one more attempt. An attempt nobody finished is otherwise
// never removed; beginning one sheds them, at the rate of sign-ins and with
// no worker to declare — the expired first, then, past the ceiling, the
// evictionCandidate. It runs in the insert's write transaction: concurrent
// begins that each counted before any of them inserted would together
// overshoot the ceiling, and the next burst would then shed far more than it
// adds, past the flooding source's attempts into everybody else's.
async function makeRoom(db: TenantScoped, now: number, keep: number): Promise<void> {
  await db.deleteFrom('signInAttempts').where('expiresAt', '<=', now).execute()
  const { pending } = await db
    .selectFrom('signInAttempts')
    .select((eb) => eb.fn.countAll<number>().as('pending'))
    .executeTakeFirstOrThrow()
  for (let excess = Number(pending) - keep; excess > 0; excess--) {
    const oldest = await evictionCandidate(db)
    if (oldest === undefined) return
    await db.deleteFrom('signInAttempts').where('state', '=', oldest.state).execute()
  }
}

function mint(
  providerId: string,
  returnTo: string,
  invitationToken: string | undefined,
  fresh: boolean,
) {
  return {
    state: random(),
    browserBinding: random(),
    nonce: random(),
    // RFC 7636 section 4.1: 43-128 characters of the unreserved set;
    // 32 random bytes in base64url are 43.
    codeVerifier: random(),
    invitationTokenHash: invitationToken === undefined ? null : sha256Hex(invitationToken),
    providerId,
    returnTo,
    fresh,
  }
}

export function createSignInAttemptStore(
  db: TenantDatabase,
  { maxPending = DEFAULT_MAX_PENDING }: SignInAttemptStoreOptions = {},
): SignInAttemptStore {
  const keep = Math.max(maxPending - 1, 0)
  return {
    async begin({ providerId, returnTo, invitationToken, fresh = false, source, now, ttlMs }) {
      const minted = mint(providerId, returnTo, invitationToken, fresh)
      await inTenantTransaction(db, async (trx) => {
        await makeRoom(trx, now, keep)
        await trx
          .insertInto('signInAttempts')
          .values({
            state: minted.state,
            browserBindingHash: sha256Hex(minted.browserBinding),
            providerId,
            nonce: minted.nonce,
            codeVerifier: minted.codeVerifier,
            invitationTokenHash: minted.invitationTokenHash,
            returnTo,
            fresh: fresh ? 1 : 0,
            expiresAt: now + ttlMs,
            ...sourceKeys(source),
          })
          .execute()
      })
      return minted
    },

    // One DELETE ... RETURNING: whichever request gets the row gets it, so a
    // replayed callback finds nothing.
    async take(state, browserBinding, now) {
      const [row] = await db
        .deleteFrom('signInAttempts')
        .where('state', '=', state)
        .where('browserBindingHash', '=', sha256Hex(browserBinding))
        .where('expiresAt', '>', now)
        .returning([
          'providerId',
          'nonce',
          'codeVerifier',
          'invitationTokenHash',
          'returnTo',
          'fresh',
        ])
        .execute()
      return row === undefined ? null : { ...row, fresh: row.fresh === 1 }
    },
  }
}
