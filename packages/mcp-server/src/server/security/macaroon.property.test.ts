/**
 * Properties of the macaroon's parser and its attenuation.
 *
 * `macaroon.test.ts` pins four malformed strings, one round trip and a few
 * hand-picked chains; what it cannot say is "for EVERY string" or "for every
 * caveat set", which is the claim a bearer-token parser actually makes. Each
 * oracle here is stated from the format's definition (a set intersection, a
 * decoded-bytes comparison done by Node's `Buffer`) rather than by calling
 * the module's own helpers, so a defect in one of those cannot move the
 * subject and its judge together.
 */
import { describe, expect, it } from 'vitest'
import { fc, withDefaults } from '../../shared/test-utils/fast-check.js'
import { AUTH_SCOPES, type AuthScope } from './auth-strategy.js'
import {
  attenuateMacaroon,
  type MacaroonCaveat,
  mintMacaroon,
  parseMacaroon,
  serializeMacaroon,
  verifyMacaroon,
} from './macaroon.js'

const ROOT_KEY = new Uint8Array(32).fill(7)
const NOW = 1_700_000_000_000
const WORKSPACE = 'ws-0'

const toBase64Url = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

// Fields are listed in the schema's own order: `serializeMacaroon` writes the
// caveat in whatever key order the caller built it, and `parseMacaroon`
// answers in the schema's, so only a caveat built in that order round-trips
// byte for byte. The signature does not care (the chain hashes a canonical
// form), which the verification half of the round trip below pins.
const scopesArb = fc.subarray([...AUTH_SCOPES], { minLength: 1 })
const caveatArb: fc.Arbitrary<MacaroonCaveat> = fc.oneof(
  fc.record({
    kind: fc.constant('workspace' as const),
    workspaceId: fc.string({ minLength: 1, unit: 'binary' }),
  }),
  fc.record({ kind: fc.constant('scope' as const), scopes: scopesArb }),
  fc.record({
    kind: fc.constant('expiresAt' as const),
    epochMs: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  }),
)
const caveatsArb = fc.array(caveatArb, { maxLength: 6 })
const tokenIdArb = fc.string({ minLength: 1, unit: 'binary' })

describe('macaroon — parsing is total over arbitrary input', () => {
  // Four families, because each reaches a different rung of the parser:
  // arbitrary text mostly dies at base64, base64 of arbitrary bytes and of
  // arbitrary JSON at the schema, and only an envelope built from the schema's
  // own fields — then broken one way at a time — reaches the acceptance side
  // and the refusals next to it. The generator that omitted it accepted
  // nothing in 400 runs while the property stayed green.
  const envelope = fc.record({
    id: fc.string({ minLength: 1 }),
    caveats: fc.array(caveatArb, { maxLength: 4 }),
    sig: fc.string({ minLength: 1 }),
  })
  const nearMiss = fc
    .oneof(
      { weight: 3, arbitrary: envelope },
      { weight: 2, arbitrary: envelope.map((value) => ({ ...value, extra: 1 })) },
      { weight: 1, arbitrary: envelope.map((value) => ({ ...value, id: '' })) },
      {
        weight: 2,
        arbitrary: fc.tuple(envelope, fc.jsonValue()).map(([value, junk]) => ({
          ...value,
          caveats: [...value.caveats, junk],
        })),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(envelope, fc.string())
          .map(([value, kind]) => ({ ...value, caveats: [{ kind }] })),
      },
      { weight: 1, arbitrary: fc.jsonValue() },
    )
    .map((value) => toBase64Url(JSON.stringify(value)))
  const inputArb = fc.oneof(
    { weight: 1, arbitrary: fc.string({ unit: 'binary' }) },
    {
      weight: 1,
      arbitrary: fc.uint8Array().map((bytes) => Buffer.from(bytes).toString('base64url')),
    },
    {
      weight: 1,
      arbitrary: fc.jsonValue().map((value) => toBase64Url(JSON.stringify(value))),
    },
    { weight: 3, arbitrary: nearMiss },
  )

  it('never throws, and either refuses or answers a macaroon that survives its own round trip', async () => {
    let accepted = 0
    let refused = 0
    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        const parsed = parseMacaroon(input)
        const verdict = await verifyMacaroon({
          token: input,
          rootKey: ROOT_KEY,
          context: { requiredScopes: [], now: NOW },
        })
        if (parsed === null) {
          refused += 1
          expect(verdict).toEqual({ ok: false, reason: 'malformed' })
          return
        }
        accepted += 1
        expect(typeof parsed.id).toBe('string')
        expect(parsed.id.length).toBeGreaterThan(0)
        expect(parsed.sig.length).toBeGreaterThan(0)
        expect(parseMacaroon(serializeMacaroon(parsed))).toEqual(parsed)
        // A well-formed envelope under a key nobody signed with is a
        // signature problem, never a parse one.
        expect(verdict).toEqual({ ok: false, reason: 'bad-signature' })
      }),
      withDefaults({ numRuns: 400 }),
    )
    // The Zod branch is only reached by the near-miss family, and only a
    // run that ACCEPTS something proves the acceptance side is exercised.
    expect(refused).toBeGreaterThan(200)
    expect(accepted).toBeGreaterThan(20)
  })
})

describe('macaroon — serialization round trip', () => {
  it('serialize(parse(mint(caveats))) is the minted token, and it still verifies', async () => {
    await fc.assert(
      fc.asyncProperty(tokenIdArb, caveatsArb, async (tokenId, caveats) => {
        const token = await mintMacaroon({ rootKey: ROOT_KEY, tokenId, caveats })
        const parsed = parseMacaroon(token)
        expect(parsed).not.toBeNull()
        expect(parsed?.id).toBe(tokenId)
        expect(parsed?.caveats).toEqual(caveats)
        const again = serializeMacaroon(parsed!)
        expect(again).toBe(token)
        // The token is a credential: a re-serialization that moved a byte
        // would present as a tampered one rather than as a formatting change.
        const verdict = await verifyMacaroon({
          token: again,
          rootKey: ROOT_KEY,
          context: {
            workspaceId: WORKSPACE,
            requiredScopes: [],
            now: NOW,
          },
        })
        expect(verdict.ok || verdict.reason !== 'bad-signature').toBe(true)
        expect(verdict.ok || verdict.reason !== 'malformed').toBe(true)
      }),
      withDefaults(),
    )
  })
})

describe('macaroon — attenuation only narrows', () => {
  // The context is fixed; the CAVEATS vary around it, so a workspace caveat is
  // satisfied about half the time and an expiry lands on either side of NOW
  // (including exactly on it, where `>` against `>=` lives).
  const context = { workspaceId: WORKSPACE, requiredScopes: [] as AuthScope[], now: NOW }
  const aroundContextArb: fc.Arbitrary<MacaroonCaveat> = fc.oneof(
    fc.record({
      kind: fc.constant('workspace' as const),
      workspaceId: fc.constantFrom(WORKSPACE, 'ws-1'),
    }),
    fc.record({ kind: fc.constant('scope' as const), scopes: scopesArb }),
    fc.record({
      kind: fc.constant('expiresAt' as const),
      epochMs: fc.constantFrom(NOW - 1, NOW, NOW + 1),
    }),
  )

  // What a caveat does to a verdict, from the definition in the module's
  // docblock: workspace must match, expiry must not have passed, scopes
  // intersect. Written as a plain fold so it shares nothing with `verify`.
  function modelled(caveats: readonly MacaroonCaveat[]) {
    let scopes: readonly AuthScope[] = AUTH_SCOPES
    for (const caveat of caveats) {
      if (caveat.kind === 'workspace' && caveat.workspaceId !== WORKSPACE) return null
      if (caveat.kind === 'expiresAt' && NOW > caveat.epochMs) return null
      if (caveat.kind === 'scope') scopes = scopes.filter((s) => caveat.scopes.includes(s))
    }
    return scopes
  }

  it('the effective scopes after a further caveat are a subset of those before, and exactly the modelled ones', async () => {
    let strictlyNarrowed = 0
    let satisfiedBoth = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(aroundContextArb, { maxLength: 4 }),
        fc.array(aroundContextArb, { minLength: 1, maxLength: 3 }),
        async (base, added) => {
          const token = await mintMacaroon({
            rootKey: ROOT_KEY,
            tokenId: 'tok-1',
            caveats: base,
          })
          let narrowed = token
          for (const caveat of added) narrowed = await attenuateMacaroon(narrowed, caveat)

          const before = await verifyMacaroon({ token, rootKey: ROOT_KEY, context })
          const after = await verifyMacaroon({ token: narrowed, rootKey: ROOT_KEY, context })

          // No holder-side step can produce a bad chain, only a satisfied or
          // an unsatisfied one.
          expect(before.ok || before.reason !== 'bad-signature').toBe(true)
          expect(after.ok || after.reason !== 'bad-signature').toBe(true)

          const modelBefore = modelled(base)
          const modelAfter = modelled([...base, ...added])
          expect(before.ok).toBe(modelBefore !== null)
          expect(after.ok).toBe(modelAfter !== null)

          if (after.ok) {
            // Narrowing never repairs a failed token ...
            expect(before.ok).toBe(true)
            if (!before.ok) return
            // ... and never widens a scope set.
            for (const scope of after.scopes) expect(before.scopes).toContain(scope)
            expect([...after.scopes].sort()).toEqual([...(modelAfter ?? [])].sort())
            satisfiedBoth += 1
            if (after.scopes.length < before.scopes.length) strictlyNarrowed += 1
          }
        },
      ),
      withDefaults(),
    )
    // Reachability: a generator whose tokens mostly fail on a workspace or an
    // expiry caveat never compares two scope sets at all.
    expect(satisfiedBoth).toBeGreaterThan(20)
    expect(strictlyNarrowed).toBeGreaterThan(10)
  })
})

describe('macaroon — a changed token never verifies', () => {
  const context = { workspaceId: WORKSPACE, requiredScopes: [] as AuthScope[], now: NOW }
  // Every caveat is satisfied by `context`, so the ONLY reason for a
  // refusal is the tampering and "unchanged" really does verify.
  const satisfiedArb: fc.Arbitrary<MacaroonCaveat> = fc.oneof(
    fc.constant({ kind: 'workspace' as const, workspaceId: WORKSPACE }),
    fc.record({ kind: fc.constant('scope' as const), scopes: scopesArb }),
    fc.constant({ kind: 'expiresAt' as const, epochMs: NOW + 1 }),
  )
  const mintedArb = fc.tuple(
    fc.string({ minLength: 1, maxLength: 12, unit: 'binary' }),
    fc.array(satisfiedArb, { maxLength: 4 }),
  )

  it('any one byte of the decoded token replaced by a different byte is refused', async () => {
    await fc.assert(
      fc.asyncProperty(
        mintedArb,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        async ([tokenId, caveats], position, delta) => {
          const token = await mintMacaroon({ rootKey: ROOT_KEY, tokenId, caveats })
          const bytes = Buffer.from(token, 'base64url')
          const at = position % bytes.length
          bytes[at] = (bytes[at]! + delta) % 256
          const verdict = await verifyMacaroon({
            token: bytes.toString('base64url'),
            rootKey: ROOT_KEY,
            context,
          })
          expect(verdict.ok, `byte ${at} of ${bytes.length}`).toBe(false)
        },
      ),
      withDefaults({ numRuns: 400 }),
    )
  })

  // The byte flip above cannot see a field the chain forgets to hash when the
  // verifier checks that field itself: a changed `workspaceId` is refused by
  // the caveat walk whatever the signature says. Editing the PARSED caveats
  // and keeping the old signature separates the two, because the signature is
  // judged first and the only correct answer is `bad-signature` — that is what
  // makes "a holder can add and nobody can remove" arithmetic.
  it('a caveat added, dropped or rewritten under the old signature is a bad signature', async () => {
    let rewrote = 0
    await fc.assert(
      fc.asyncProperty(
        tokenIdArb,
        fc.array(caveatArb, { minLength: 1, maxLength: 4 }),
        caveatArb,
        fc.nat(),
        fc.constantFrom('add', 'drop', 'rewrite'),
        async (tokenId, caveats, other, position, edit) => {
          const token = await mintMacaroon({ rootKey: ROOT_KEY, tokenId, caveats })
          const parsed = parseMacaroon(token)!
          const at = position % caveats.length
          const edited =
            edit === 'add'
              ? [...caveats, other]
              : edit === 'drop'
                ? caveats.filter((_, index) => index !== at)
                : caveats.map((caveat, index) => (index === at ? other : caveat))
          if (JSON.stringify(edited) === JSON.stringify(caveats)) return
          if (edit === 'rewrite') rewrote += 1
          const forged = serializeMacaroon({ ...parsed, caveats: edited })
          await expect(
            verifyMacaroon({ token: forged, rootKey: ROOT_KEY, context }),
          ).resolves.toEqual({ ok: false, reason: 'bad-signature' })
        },
      ),
      withDefaults(),
    )
    expect(rewrote).toBeGreaterThan(30)
  })

  // The same claim one layer out, over the CHARACTERS of the string a client
  // holds. Here a flip CAN be a no-op, and that is measured rather than
  // excluded: the final character of a token whose length is not a multiple
  // of four carries bits base64 discards. So the stated claim is "verifies
  // exactly when the decoded bytes are unchanged", the unchanged side judged
  // by Node's own `Buffer` decoder and not by the module's `atob` — with one
  // correction the oracle needs: Node also reads `+`/`/` as `-`/`_`, while
  // the token's grammar is url-only, so a swap to either is a refusal
  // whatever bytes Node makes of it. They stay in the draw for that reason.
  const alphabet = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/']
  const URL_ALPHABET = /^[A-Za-z0-9_-]$/
  it('one changed character verifies only if it left the decoded bytes unchanged', async () => {
    let sameBytes = 0
    let changedBytes = 0
    await fc.assert(
      fc.asyncProperty(
        mintedArb,
        fc.oneof(fc.nat(), fc.constant(-1)),
        fc.constantFrom(...alphabet),
        async ([tokenId, caveats], position, replacement) => {
          const token = await mintMacaroon({ rootKey: ROOT_KEY, tokenId, caveats })
          const at = position < 0 ? token.length - 1 : position % token.length
          if (token[at] === replacement) return
          const mutated = `${token.slice(0, at)}${replacement}${token.slice(at + 1)}`
          const unchanged =
            URL_ALPHABET.test(replacement) &&
            Buffer.from(mutated, 'base64url').equals(Buffer.from(token, 'base64url'))
          const verdict = await verifyMacaroon({ token: mutated, rootKey: ROOT_KEY, context })
          expect(verdict.ok, `char ${at} of ${token.length}: ${token[at]} -> ${replacement}`).toBe(
            unchanged,
          )
          if (unchanged) sameBytes += 1
          else changedBytes += 1
        },
      ),
      withDefaults({ numRuns: 400 }),
    )
    expect(changedBytes).toBeGreaterThan(300)
    // The no-op region is reached on purpose (the `-1` position), so the
    // `unchanged` direction is asserted and not merely allowed.
    expect(sameBytes).toBeGreaterThan(0)
  })
})
