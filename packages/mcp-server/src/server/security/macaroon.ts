/**
 * A macaroon: a bearer token whose caveats can be added by whoever holds it
 * and removed by nobody, implementing [ADR-0043](../../../../../docs/contributing/adr/0043-authority-as-keys.md)
 * decision 4 on the ACT plane.
 *
 * The construction is the chained HMAC from *Macaroons: Cookies with
 * Contextual Caveats for Decentralized Authorization in the Cloud*
 * (Birgisson et al., NDSS 2014):
 *
 *     sig₀ = HMAC(rootKey, tokenId)
 *     sigᵢ = HMAC(sigᵢ₋₁, caveatᵢ)
 *
 * Adding a caveat needs only the current signature, so a holder can narrow
 * what it holds without asking the daemon. Removing one needs `sigᵢ₋₁`,
 * which HMAC does not yield from `sigᵢ` — so **attenuation is arithmetic
 * rather than a rule somebody enforces**, which is the property this whole
 * file exists for.
 *
 * Two deliberate choices, both from ADR-0043:
 *
 * - **HMAC rather than a public-key signature.** The daemon is both issuer
 *   and verifier, so "anyone who can verify can also forge" costs nothing
 *   here. A verifier that must NOT be able to mint is the named trigger to
 *   move to Biscuit (decision 6), and the day that arrives this file is the
 *   thing that gets replaced.
 * - **WebCrypto rather than `node:crypto`.** This package is Node-only
 *   today, but the holder that attenuates need not be: `crypto.subtle`
 *   exists unchanged in the browser and in a Worker, so moving this module
 *   to `daemon-client` stays a move rather than a rewrite. That is also why
 *   the API is async — `subtle.sign` is.
 *
 * Caveats are Zod-schema'd predicates rather than a policy language. A
 * macaroon's first-party caveats are opaque to the format and interpreted
 * by the verifier, so this follows the construction rather than departing
 * from it, and keeps one schema language in the codebase.
 *
 * **What is NOT checked here, stated because the ADR promised it.**
 * ADR-0043 decision 5 names "libmacaroons publishes test vectors, so the
 * implementation is checked against the reference rather than against
 * itself" as one of three conditions under which hand-rolling this was
 * judged acceptable. That condition is not met and cannot be met by this
 * module: libmacaroons' vectors are SERIALIZATION vectors — the same
 * macaroon rendered in its V1 (base64 packet) and V2 (binary) formats —
 * and they exercise its wire format, not the abstract chain. This module
 * uses its own JSON serialization and adds domain-separation tags that
 * libmacaroons' chain does not have, so its signatures differ by design
 * and no vector can match.
 *
 * What stands in its place is weaker and is not pretended otherwise: the
 * primitive is WebCrypto's HMAC-SHA-256 rather than a hand-written one, and
 * `macaroon.test.ts` pins the construction with committed golden values so
 * a silent change to a tag or an encoding fails. Neither is an independent
 * implementation agreeing with this one. Adopting libmacaroons' wire format
 * outright is the option that would buy the real check; it was not taken
 * here, and that is a decision someone can revisit rather than a gap nobody
 * noticed.
 */
import { z } from 'zod'
import { ALL_AUTH_SCOPES, AUTH_SCOPES, type AuthScope } from './auth-strategy.js'
import { timingSafeEqualStrings } from './timing-safe.js'

// Domain-separation tags. The chain's two links hash different things, and a
// caveat payload must never be mistakable for a root payload.
const ROOT_TAG = 'wb-macaroon-root-v1'
const CAVEAT_TAG = 'wb-macaroon-caveat-v1'

const macaroonCaveatSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), workspaceId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('scope'), scopes: z.array(z.enum(AUTH_SCOPES)).min(1) }).strict(),
  z.object({ kind: z.literal('expiresAt'), epochMs: z.number().int().nonnegative() }).strict(),
])

export type MacaroonCaveat = z.infer<typeof macaroonCaveatSchema>

const macaroonSchema = z
  .object({
    id: z.string().min(1),
    caveats: z.array(macaroonCaveatSchema),
    sig: z.string().min(1),
  })
  .strict()

export type Macaroon = z.infer<typeof macaroonSchema>

export interface MacaroonContext {
  readonly workspaceId?: string
  readonly requiredScopes: readonly AuthScope[]
  readonly now: number
}

export type MacaroonVerdict =
  | { ok: true; tokenId: string; scopes: readonly AuthScope[] }
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: 'bad-signature' }
  | { ok: false; reason: 'caveat-unsatisfied'; caveat: MacaroonCaveat['kind'] }

// btoa/atob rather than Buffer, for the portability reason in the docblock —
// `did-key.ts` takes the same route for the same reason.
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array | null {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * JSON-array encoding, so part boundaries are unambiguous: `["ab","c"]` and
 * `["a","bc"]` serialize differently and no length-prefixing scheme is
 * needed. `daemon-identity.ts`'s `buildSignedPayload` solves the same
 * problem the same way; this is its WebCrypto-side twin.
 */
function payload(parts: readonly string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parts))
}

/**
 * A caveat's canonical bytes. Written per kind with a fixed field order
 * rather than `JSON.stringify(caveat)`, because object key order is a
 * property of how the value was BUILT — a caveat that round-trips through
 * `parseMacaroon` could otherwise hash differently from the one that was
 * signed, and the failure would look like tampering.
 */
function canonicalCaveat(caveat: MacaroonCaveat): readonly string[] {
  switch (caveat.kind) {
    case 'workspace':
      return [caveat.kind, caveat.workspaceId]
    case 'scope':
      return [caveat.kind, ...caveat.scopes]
    case 'expiresAt':
      return [caveat.kind, String(caveat.epochMs)]
  }
}

async function hmac(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message as BufferSource))
}

async function chain(
  rootKey: Uint8Array,
  tokenId: string,
  caveats: readonly MacaroonCaveat[],
): Promise<Uint8Array> {
  let signature = await hmac(rootKey, payload([ROOT_TAG, tokenId]))
  for (const caveat of caveats) {
    signature = await hmac(signature, payload([CAVEAT_TAG, ...canonicalCaveat(caveat)]))
  }
  return signature
}

export function serializeMacaroon(macaroon: Macaroon): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(macaroon)))
}

/** Total: answers null for anything that is not a well-formed macaroon. */
export function parseMacaroon(token: string): Macaroon | null {
  const bytes = base64UrlToBytes(token)
  if (bytes === null) return null
  try {
    const parsed = macaroonSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function mintMacaroon(options: {
  rootKey: Uint8Array
  tokenId: string
  caveats?: readonly MacaroonCaveat[]
}): Promise<string> {
  const caveats = options.caveats ?? []
  const signature = await chain(options.rootKey, options.tokenId, caveats)
  return serializeMacaroon({
    id: options.tokenId,
    caveats: [...caveats],
    sig: bytesToBase64Url(signature),
  })
}

/**
 * Narrow a token the holder already has. Takes no root key — that is the
 * point: a holder attenuates offline, without asking the issuer.
 *
 * Note this extends the chain unconditionally, including with a caveat that
 * is WIDER than one already present. That is not a hole: a wider caveat
 * added later cannot undo a narrower one, because verification takes the
 * intersection of every scope caveat. Adding `canvas:write` to a token
 * caveated to `canvas:read` yields a token that still cannot write.
 */
export async function attenuateMacaroon(token: string, caveat: MacaroonCaveat): Promise<string> {
  const macaroon = parseMacaroon(token)
  if (macaroon === null) throw new Error('cannot attenuate a malformed macaroon')
  const current = base64UrlToBytes(macaroon.sig)
  if (current === null) throw new Error('cannot attenuate a malformed macaroon')

  const next = await hmac(current, payload([CAVEAT_TAG, ...canonicalCaveat(caveat)]))
  return serializeMacaroon({
    id: macaroon.id,
    caveats: [...macaroon.caveats, caveat],
    sig: bytesToBase64Url(next),
  })
}

/**
 * The effective scope set: the INTERSECTION of every scope caveat, which is
 * what makes each attenuation narrowing and never widening.
 *
 * A token carrying no scope caveat is unnarrowed on this axis and resolves
 * to the full vocabulary. That is a real default rather than an oversight —
 * the daemon mints with a scope caveat, and a token without one is the
 * today-shaped credential this design is replacing.
 */
function effectiveScopes(caveats: readonly MacaroonCaveat[]): readonly AuthScope[] {
  let scopes: readonly AuthScope[] = ALL_AUTH_SCOPES
  for (const caveat of caveats) {
    if (caveat.kind !== 'scope') continue
    const allowed = new Set(caveat.scopes)
    scopes = scopes.filter((scope) => allowed.has(scope))
  }
  return scopes
}

export async function verifyMacaroon(options: {
  token: string
  rootKey: Uint8Array
  context: MacaroonContext
}): Promise<MacaroonVerdict> {
  const macaroon = parseMacaroon(options.token)
  if (macaroon === null) return { ok: false, reason: 'malformed' }

  const expected = await chain(options.rootKey, macaroon.id, macaroon.caveats)
  if (!timingSafeEqualStrings(macaroon.sig, bytesToBase64Url(expected))) {
    return { ok: false, reason: 'bad-signature' }
  }

  for (const caveat of macaroon.caveats) {
    if (caveat.kind === 'workspace' && options.context.workspaceId !== caveat.workspaceId) {
      return { ok: false, reason: 'caveat-unsatisfied', caveat: 'workspace' }
    }
    if (caveat.kind === 'expiresAt' && options.context.now > caveat.epochMs) {
      return { ok: false, reason: 'caveat-unsatisfied', caveat: 'expiresAt' }
    }
  }

  // Scope is checked after the walk rather than inside it, because it is the
  // one caveat whose meaning depends on every other instance of itself.
  const scopes = effectiveScopes(macaroon.caveats)
  const granted = new Set(scopes)
  if (!options.context.requiredScopes.every((scope) => granted.has(scope))) {
    return { ok: false, reason: 'caveat-unsatisfied', caveat: 'scope' }
  }

  return { ok: true, tokenId: macaroon.id, scopes }
}
