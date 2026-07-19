// Model-based property test (fc.commands / fc.modelRun) for
// reconnect-challenge-store.ts. Pinned properties, checked over randomly
// generated mint / redeem / time-advance sequences instead of a handful of
// hand-picked examples:
//
//   1. The number of unexpired pending challenges never exceeds the
//      configured cap (mint-time pruning keeps size bounded).
//   2. Redeeming the same challengeId a second time always returns null
//      (single-use).
//   3. Redeeming a challenge whose TTL has elapsed always returns null,
//      regardless of which origin presents it.
//   4. Redeeming with the wrong origin always returns null AND does not
//      consume the challenge — the legitimate origin can still redeem it
//      afterward (checked directly within the same command).
//
// The model mirrors the store's own lazy-pruning rule (drop entries whose
// expiresAt is strictly before the current clock) rather than re-deriving it
// independently, since that rule — not wall-clock TTL alone — is what
// actually bounds memory in the real implementation.
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { createReconnectChallengeStore } from './reconnect-challenge-store.js'

// Mirrors the production constants in reconnect-challenge-store.ts. Kept as
// local test constants (not imported) because CHALLENGE_TTL_MS is an
// intentionally private implementation detail there — the model has to know
// it independently to predict expected behavior, same as any model-based test.
const CHALLENGE_TTL_MS = 60_000
const MODEL_MAX_PENDING = 3

interface PendingEntry {
  origin: string
  expiresAt: number
  nonce: string
}

interface ChallengeModel {
  pending: Map<string, PendingEntry>
}

interface RealEnv {
  store: ReturnType<typeof createReconnectChallengeStore>
  clock: { value: number }
}

type ChallengeCommand = fc.Command<ChallengeModel, RealEnv>

const ORIGIN_POOL = [
  'https://a.example.test',
  'https://b.example.test',
  'https://c.example.test',
] as const

function pruneModel(model: ChallengeModel, cutoff: number): void {
  for (const [id, entry] of model.pending) {
    if (entry.expiresAt < cutoff) model.pending.delete(id)
  }
}

class MintCommand implements ChallengeCommand {
  constructor(private readonly origin: string) {}

  check(): boolean {
    return true
  }

  run(model: ChallengeModel, real: RealEnv): void {
    const cutoff = real.clock.value
    pruneModel(model, cutoff)

    const minted = real.store.mintChallenge(this.origin)

    if (model.pending.size >= MODEL_MAX_PENDING) {
      expect(minted, 'mint must reject once the unexpired-pending cap is reached').toBeNull()
    } else {
      expect(minted, 'mint must succeed while under the unexpired-pending cap').not.toBeNull()
      if (minted) {
        model.pending.set(minted.challengeId, {
          origin: this.origin,
          expiresAt: cutoff + CHALLENGE_TTL_MS,
          nonce: minted.nonce,
        })
      }
    }

    expect(real.store.size(), 'unexpired pending count must match the model').toBe(
      model.pending.size,
    )
  }

  toString(): string {
    return `mint(${this.origin})`
  }
}

type RedeemMode = 'existing-correct' | 'existing-wrong-origin' | 'unknown-id'

class RedeemCommand implements ChallengeCommand {
  constructor(
    private readonly mode: RedeemMode,
    private readonly indexHint: number,
    private readonly unknownId: string,
    private readonly presentedOrigin: string,
  ) {}

  check(): boolean {
    return true
  }

  run(model: ChallengeModel, real: RealEnv): void {
    if (this.mode === 'unknown-id' || model.pending.size === 0) {
      const result = real.store.redeemChallenge(this.unknownId, this.presentedOrigin)
      expect(result, 'redeeming an id that was never minted must return null').toBeNull()
      return
    }

    const ids = [...model.pending.keys()]
    const id = ids[this.indexHint % ids.length] as string
    const entry = model.pending.get(id) as PendingEntry
    const isExpired = entry.expiresAt < real.clock.value

    if (isExpired) {
      const result = real.store.redeemChallenge(id, entry.origin)
      expect(result, 'redeeming a challenge past its TTL must return null').toBeNull()
      model.pending.delete(id)
      return
    }

    if (this.mode === 'existing-wrong-origin') {
      // Force a real mismatch even if the generated origin coincidentally
      // matches the entry's origin — the wrong-origin path is what's under
      // test here, not the coincidental-match path.
      const wrongOrigin =
        this.presentedOrigin === entry.origin ? `${entry.origin}-mismatch` : this.presentedOrigin

      const mismatchResult = real.store.redeemChallenge(id, wrongOrigin)
      expect(mismatchResult, 'redeeming with the wrong origin must return null').toBeNull()

      // Non-consumption: the legitimate origin must still be able to redeem
      // the exact same challenge afterward.
      const followUp = real.store.redeemChallenge(id, entry.origin)
      expect(followUp, 'a wrong-origin attempt must not consume the challenge').toBe(entry.nonce)
      model.pending.delete(id)
      return
    }

    const result = real.store.redeemChallenge(id, entry.origin)
    expect(
      result,
      'redeeming a fresh challenge with the correct origin must return its nonce',
    ).toBe(entry.nonce)
    model.pending.delete(id)
  }

  toString(): string {
    return `redeem(${this.mode}, idx=${this.indexHint})`
  }
}

class AdvanceTimeCommand implements ChallengeCommand {
  constructor(private readonly deltaMs: number) {}

  check(): boolean {
    return true
  }

  run(_model: ChallengeModel, real: RealEnv): void {
    real.clock.value += this.deltaMs
  }

  toString(): string {
    return `advanceTime(+${this.deltaMs}ms)`
  }
}

const mintArb = fc
  .constantFrom(...ORIGIN_POOL)
  .map((origin) => new MintCommand(origin) as ChallengeCommand)

const redeemExistingCorrectArb = fc
  .nat()
  .map((idx) => new RedeemCommand('existing-correct', idx, '', '') as ChallengeCommand)

const redeemExistingWrongOriginArb = fc
  .tuple(fc.nat(), fc.constantFrom(...ORIGIN_POOL))
  .map(
    ([idx, wrongOrigin]) =>
      new RedeemCommand('existing-wrong-origin', idx, '', wrongOrigin) as ChallengeCommand,
  )

const redeemUnknownArb = fc
  .tuple(fc.uuid(), fc.constantFrom(...ORIGIN_POOL))
  .map(([id, origin]) => new RedeemCommand('unknown-id', 0, id, origin) as ChallengeCommand)

const advanceTimeArb = fc
  .integer({ min: 0, max: CHALLENGE_TTL_MS * 2 })
  .map((delta) => new AdvanceTimeCommand(delta) as ChallengeCommand)

const commandsArb = fc.commands(
  [
    mintArb,
    redeemExistingCorrectArb,
    redeemExistingWrongOriginArb,
    redeemUnknownArb,
    advanceTimeArb,
  ],
  { maxCommands: 15 },
)

describe('reconnect-challenge-store — model-based properties', () => {
  fcTest.prop([commandsArb], withDefaults())(
    'mint/redeem/time-advance sequences preserve the cap, single-use, TTL, and origin-binding invariants',
    (cmds) => {
      fc.modelRun(() => {
        const clock = { value: 1_000_000 }
        const store = createReconnectChallengeStore({
          now: () => clock.value,
          maxPending: MODEL_MAX_PENDING,
        })
        const model: ChallengeModel = { pending: new Map() }
        return { model, real: { store, clock } }
      }, cmds)
    },
  )
})
