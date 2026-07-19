// Model-based property test (fc.commands / fc.asyncModelRun) for
// web-origin-trust-store.ts. Pinned properties, checked over randomly
// generated enroll / legacy-trust / verify / revoke / time-advance
// sequences instead of a handful of hand-picked examples:
//
//   1. Whenever an origin has a record, that record carries at least one
//      credential (a public key or a legacy secret hash) — the store never
//      produces a credential-less record through its own API.
//   2. Once a record's TTL has elapsed (sliding for a keypair credential;
//      sliding OR absolute for a legacy secret), every verify against it
//      fails, even with a cryptographically valid signature or the exact
//      correct secret.
//   3. Once an origin is revoked, every verify against it fails.
//   4. Re-enrolling an identical, still-fresh public key is a no-op
//      (idempotent — does not bump trustedAt).
//
// ECDSA P-256 keypairs and their signatures over a small, fixed pool of
// nonces are generated once in beforeAll and reused across every property
// run — signing is the slow step here, and the pool is small enough that
// precomputing it does not weaken what the property explores (which key is
// enrolled/verified against which origin, and in what order, is still fully
// randomized per run).
import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect } from 'vitest'
import type { EcP256PublicJwk } from '../../shared/api-contracts/reconnect.js'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { createWebOriginTrustStore, TRUST_TTL_MS } from './web-origin-trust-store.js'

// Mirrors the production LEGACY_SECRET_ABSOLUTE_TTL_MS constant in
// web-origin-trust-store.ts. Kept as a local test constant (not imported)
// because it is an intentionally private implementation detail there — the
// model has to know it independently to predict expected behavior, same as
// any model-based test.
const LEGACY_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000

const ORIGIN_POOL = ['http://localhost:5173', 'http://localhost:6000'] as const
const NONCE_POOL = ['nonce-alpha', 'nonce-beta', 'nonce-gamma'] as const

interface KeyFixture {
  publicJwk: EcP256PublicJwk
  privateKey: CryptoKey
  // signatures[nonceIndex] — precomputed once in beforeAll.
  signatures: string[]
}

let KEYS: KeyFixture[]

async function generateKeyPair(): Promise<{ publicJwk: EcP256PublicJwk; privateKey: CryptoKey }> {
  const keyPair = (await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const exported = (await webcrypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey
  const publicJwk: EcP256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x as string,
    y: exported.y as string,
  }
  return { publicJwk, privateKey: keyPair.privateKey }
}

async function sign(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(message),
  )
  return Buffer.from(signature).toString('base64url')
}

beforeAll(async () => {
  const pair1 = await generateKeyPair()
  const pair2 = await generateKeyPair()
  KEYS = await Promise.all(
    [pair1, pair2].map(async (pair) => ({
      publicJwk: pair.publicJwk,
      privateKey: pair.privateKey,
      signatures: await Promise.all(NONCE_POOL.map((nonce) => sign(pair.privateKey, nonce))),
    })),
  )
})

type ModelRecord =
  | { credential: 'key'; keyIndex: number; trustedAt: number; lastUsedAt: number }
  | { credential: 'legacy'; secret: string; trustedAt: number; lastUsedAt: number }

interface TrustModel {
  records: Map<string, ModelRecord>
}

interface RealEnv {
  store: ReturnType<typeof createWebOriginTrustStore>
  clock: { value: number }
}

type TrustCommand = fc.AsyncCommand<TrustModel, RealEnv>

function isFresh(record: ModelRecord, now: number): boolean {
  return now - record.lastUsedAt <= TRUST_TTL_MS
}

function isWithinLegacyAbsoluteTtl(record: ModelRecord, now: number): boolean {
  return now - record.trustedAt <= LEGACY_ABSOLUTE_TTL_MS
}

async function assertEveryRecordHasACredential(real: RealEnv): Promise<void> {
  for (const record of await real.store.list()) {
    expect(
      Boolean(record.publicKeyJwk) || Boolean(record.secretHash),
      `record for ${record.origin} must carry at least one credential`,
    ).toBe(true)
  }
}

class TrustLegacyCommand implements TrustCommand {
  constructor(private readonly origin: string) {}

  check(): boolean {
    return true
  }

  async run(model: TrustModel, real: RealEnv): Promise<void> {
    const { secret } = await real.store.trustOrigin(this.origin)
    const now = real.clock.value
    // trustOrigin() overwrites unconditionally, including dropping any
    // enrolled public key — mirror that rather than preserving trustedAt.
    model.records.set(this.origin, {
      credential: 'legacy',
      secret,
      trustedAt: now,
      lastUsedAt: now,
    })
    await assertEveryRecordHasACredential(real)
  }

  toString(): string {
    return `trustLegacy(${this.origin})`
  }
}

class EnrollKeyCommand implements TrustCommand {
  constructor(
    private readonly origin: string,
    private readonly keyIndex: number,
  ) {}

  check(): boolean {
    return true
  }

  async run(model: TrustModel, real: RealEnv): Promise<void> {
    const existing = model.records.get(this.origin)
    const now = real.clock.value
    const isIdempotentNoOp =
      existing?.credential === 'key' &&
      existing.keyIndex === this.keyIndex &&
      isFresh(existing, now)

    await real.store.enrollPublicKey(this.origin, KEYS[this.keyIndex]!.publicJwk)

    if (!isIdempotentNoOp) {
      model.records.set(this.origin, {
        credential: 'key',
        keyIndex: this.keyIndex,
        trustedAt: existing?.trustedAt ?? now,
        lastUsedAt: now,
      })
    }
    await assertEveryRecordHasACredential(real)
  }

  toString(): string {
    return `enrollKey(${this.origin}, key=${this.keyIndex})`
  }
}

class VerifySignedCommand implements TrustCommand {
  constructor(
    private readonly origin: string,
    private readonly keyIndex: number,
    private readonly nonceIndex: number,
  ) {}

  check(): boolean {
    return true
  }

  async run(model: TrustModel, real: RealEnv): Promise<void> {
    const nonce = NONCE_POOL[this.nonceIndex]!
    const signature = KEYS[this.keyIndex]!.signatures[this.nonceIndex]!
    const now = real.clock.value

    const record = model.records.get(this.origin)
    const expectedOk =
      record !== undefined &&
      record.credential === 'key' &&
      record.keyIndex === this.keyIndex &&
      isFresh(record, now)

    const result = await real.store.verifySignedChallenge(this.origin, nonce, signature)
    expect(
      result,
      `verifySignedChallenge(${this.origin}, key=${this.keyIndex}) expected ${expectedOk}`,
    ).toBe(expectedOk)

    if (expectedOk && record) {
      record.lastUsedAt = now // sliding TTL touch on success
      // Success also persists an updated record (lastUsedAt bump) — a
      // regression that dropped the credential while writing that update
      // must be caught here too, not only after trust/enrollment.
      await assertEveryRecordHasACredential(real)
    }
  }

  toString(): string {
    return `verifySigned(${this.origin}, key=${this.keyIndex}, nonce=${this.nonceIndex})`
  }
}

class VerifyLegacyCommand implements TrustCommand {
  constructor(
    private readonly origin: string,
    private readonly presentCorrect: boolean,
    private readonly wrongSecretSeed: string,
  ) {}

  check(): boolean {
    return true
  }

  async run(model: TrustModel, real: RealEnv): Promise<void> {
    const now = real.clock.value
    const record = model.records.get(this.origin)
    const canPresentCorrect = this.presentCorrect && record?.credential === 'legacy'
    const secretToPresent = canPresentCorrect
      ? (record as { secret: string }).secret
      : `wrong-${this.wrongSecretSeed}`

    const expectedOk =
      canPresentCorrect &&
      record !== undefined &&
      record.credential === 'legacy' &&
      isFresh(record, now) &&
      isWithinLegacyAbsoluteTtl(record, now)

    const result = await real.store.verifyLegacySecret(this.origin, secretToPresent)
    expect(result, `verifyLegacySecret(${this.origin}) expected ${expectedOk}`).toBe(expectedOk)

    if (expectedOk && record) {
      record.lastUsedAt = now
      // Same rationale as VerifySignedCommand — a successful legacy verify
      // also persists an updated record, so re-check the credential invariant
      // here rather than only after trust/enrollment commands.
      await assertEveryRecordHasACredential(real)
    }
  }

  toString(): string {
    return `verifyLegacy(${this.origin}, correct=${this.presentCorrect})`
  }
}

class RevokeCommand implements TrustCommand {
  constructor(private readonly origin: string) {}

  check(): boolean {
    return true
  }

  async run(model: TrustModel, real: RealEnv): Promise<void> {
    // Capture the credential that is about to be revoked so it can be
    // presented again immediately after — revoke() deletes the underlying
    // record, so without this a later VerifyLegacyCommand always submits a
    // fabricated wrong secret and never actually exercises revocation
    // against the credential that was live at revoke time.
    const existing = model.records.get(this.origin)

    await real.store.revoke(this.origin)
    model.records.delete(this.origin)

    if (existing?.credential === 'legacy') {
      const result = await real.store.verifyLegacySecret(this.origin, existing.secret)
      expect(
        result,
        `verifyLegacySecret(${this.origin}) with the just-revoked secret must fail`,
      ).toBe(false)
    } else if (existing?.credential === 'key') {
      const nonce = NONCE_POOL[0]!
      const signature = KEYS[existing.keyIndex]!.signatures[0]!
      const result = await real.store.verifySignedChallenge(this.origin, nonce, signature)
      expect(
        result,
        `verifySignedChallenge(${this.origin}) with the just-revoked key must fail`,
      ).toBe(false)
    }
  }

  toString(): string {
    return `revoke(${this.origin})`
  }
}

class AdvanceTimeCommand implements TrustCommand {
  constructor(private readonly deltaMs: number) {}

  check(): boolean {
    return true
  }

  async run(_model: TrustModel, real: RealEnv): Promise<void> {
    real.clock.value += this.deltaMs
  }

  toString(): string {
    return `advanceTime(+${this.deltaMs}ms)`
  }
}

// Deltas stay under the sliding TTL (30d) so a sequence of repeated
// "advance, verify" pairs can accumulate well past the legacy-absolute TTL
// (90d) while each individual gap still keeps the sliding TTL fresh — that
// specific "sliding fresh, absolute expired" combination is what
// distinguishes the two TTL checks, so uniformly large single jumps (which
// would trip both at once) would never isolate the absolute-TTL guard.
const MAX_TIME_DELTA_MS = 25 * 24 * 60 * 60 * 1000

const trustLegacyArb = fc
  .constantFrom(...ORIGIN_POOL)
  .map((origin) => new TrustLegacyCommand(origin) as TrustCommand)

const enrollKeyArb = fc
  .tuple(fc.constantFrom(...ORIGIN_POOL), fc.integer({ min: 0, max: 1 }))
  .map(([origin, keyIndex]) => new EnrollKeyCommand(origin, keyIndex) as TrustCommand)

const verifySignedArb = fc
  .tuple(
    fc.constantFrom(...ORIGIN_POOL),
    fc.integer({ min: 0, max: 1 }),
    fc.integer({ min: 0, max: NONCE_POOL.length - 1 }),
  )
  .map(
    ([origin, keyIndex, nonceIndex]) =>
      new VerifySignedCommand(origin, keyIndex, nonceIndex) as TrustCommand,
  )

const verifyLegacyArb = fc
  .tuple(fc.constantFrom(...ORIGIN_POOL), fc.boolean(), fc.string({ minLength: 1, maxLength: 8 }))
  .map(
    ([origin, presentCorrect, seed]) =>
      new VerifyLegacyCommand(origin, presentCorrect, seed) as TrustCommand,
  )

const revokeArb = fc
  .constantFrom(...ORIGIN_POOL)
  .map((origin) => new RevokeCommand(origin) as TrustCommand)

const advanceTimeArb = fc
  .integer({ min: 0, max: MAX_TIME_DELTA_MS })
  .map((delta) => new AdvanceTimeCommand(delta) as TrustCommand)

// verifyLegacyArb and advanceTimeArb are listed multiple times to bias
// fc.commands' generation toward long "advance a bit, verify legacy" runs —
// the sequence shape that isolates the legacy-absolute TTL from the
// sliding TTL (see MAX_TIME_DELTA_MS above). Without the bias, mixing in
// enroll/revoke/trustLegacy at equal weight makes that specific shape too
// rare across a bounded numRuns to reliably exercise the absolute-TTL guard.
const commandsArb = fc.commands(
  [trustLegacyArb, enrollKeyArb, verifySignedArb, verifyLegacyArb, revokeArb, advanceTimeArb],
  { maxCommands: 15 },
)

// A dedicated command that atomically advances the clock by less than the
// sliding TTL and then immediately verifies the (single, pre-trusted)
// origin. Composing "advance, then verify" as two independently-generated
// commands in a shared fc.commands pool lets fast-check freely interleave
// them with OTHER origins/operations and, critically, lets multiple
// advances land back-to-back with no intervening verify of the SAME
// origin — either of which can let the gap since that origin's last verify
// exceed the sliding TTL and expire it first, before the sequence ever
// accumulates enough total elapsed time to isolate the legacy-absolute TTL
// on its own. Atomicity removes that confound: every step keeps the gap
// bounded, so only cumulative elapsed time (which the absolute TTL, not the
// sliding TTL, is measured from) can eventually make verify fail.
class AdvanceThenVerifyLegacyCommand implements TrustCommand {
  constructor(
    private readonly origin: string,
    private readonly deltaMs: number,
  ) {}

  check(): boolean {
    return true
  }

  async run(model: TrustModel, real: RealEnv): Promise<void> {
    real.clock.value += this.deltaMs
    const now = real.clock.value

    const record = model.records.get(this.origin)
    const expectedOk =
      record !== undefined &&
      record.credential === 'legacy' &&
      isFresh(record, now) &&
      isWithinLegacyAbsoluteTtl(record, now)

    const secret = record?.credential === 'legacy' ? record.secret : 'never-trusted'
    const result = await real.store.verifyLegacySecret(this.origin, secret)
    expect(result, `verifyLegacySecret(${this.origin}) at +${now}ms expected ${expectedOk}`).toBe(
      expectedOk,
    )

    if (expectedOk && record) {
      record.lastUsedAt = now
    }
  }

  toString(): string {
    return `advanceThenVerifyLegacy(${this.origin}, +${this.deltaMs}ms)`
  }
}

// Single origin only: with two origins sharing one clock, a run of steps
// targeting origin B lets origin A's gap-since-last-verify grow unattended,
// which can expire A on the sliding TTL before the sequence has accumulated
// enough total elapsed time to isolate the absolute TTL for A specifically.
// Restricting to one origin keeps every step's gap bounded for THE origin
// under test, isolating cumulative elapsed time as the only thing that can
// eventually fail the check.
const LEGACY_TTL_BOUNDARY_ORIGIN = ORIGIN_POOL[0]

const legacyTtlBoundaryCommandsArb = fc.commands(
  [
    fc
      .integer({ min: 1, max: 29 })
      .map(
        (days) =>
          new AdvanceThenVerifyLegacyCommand(
            LEGACY_TTL_BOUNDARY_ORIGIN,
            days * 24 * 60 * 60 * 1000,
          ) as TrustCommand,
      ),
  ],
  { maxCommands: 20 },
)

describe('web-origin-trust-store — model-based properties', () => {
  fcTest.prop([commandsArb], withDefaults({ numRuns: 40 }))(
    'enroll/trust/verify/revoke/time-advance sequences preserve credential, TTL, and revocation invariants',
    async (cmds) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-web-origin-trust-pbt-'))
      try {
        await fc.asyncModelRun(async () => {
          const clock = { value: Date.parse('2026-01-01T00:00:00.000Z') }
          const store = createWebOriginTrustStore({ dataDir, now: () => clock.value })
          const model: TrustModel = { records: new Map() }
          return { model, real: { store, clock } }
        }, cmds)
      } finally {
        await rm(dataDir, { recursive: true, force: true })
      }
    },
  )

  fcTest.prop([legacyTtlBoundaryCommandsArb], withDefaults({ numRuns: 40 }))(
    'repeated legacy verify + small time-advances still expire on the legacy-absolute TTL even while the sliding TTL stays fresh',
    async (cmds) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-web-origin-trust-ttl-pbt-'))
      try {
        await fc.asyncModelRun(async () => {
          const clock = { value: Date.parse('2026-01-01T00:00:00.000Z') }
          const store = createWebOriginTrustStore({ dataDir, now: () => clock.value })
          const { secret } = await store.trustOrigin(LEGACY_TTL_BOUNDARY_ORIGIN)
          const model: TrustModel = {
            records: new Map([
              [
                LEGACY_TTL_BOUNDARY_ORIGIN,
                { credential: 'legacy', secret, trustedAt: clock.value, lastUsedAt: clock.value },
              ],
            ]),
          }
          return { model, real: { store, clock } }
        }, cmds)
      } finally {
        await rm(dataDir, { recursive: true, force: true })
      }
    },
  )
})
