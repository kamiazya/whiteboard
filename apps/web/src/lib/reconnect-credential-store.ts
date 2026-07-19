import { z } from 'zod'

// Deliberately NOT part of user-settings-store's schema/export surface: this
// value is a possession credential that redeems the full-authority daemon
// token (see reconnect.ts), not a UI preference — keeping it out of
// UserSettings keeps it out of any future settings-export/import feature.
export const STORAGE_KEY = 'whiteboard.reconnect-secret.v1'

const recordSchema = z
  .object({
    origin: z.string(),
    secret: z.string().min(1),
  })
  .strict()

// Canonicalizes to a bare origin (scheme + host + port, WHATWG `URL#origin`)
// and rejects anything carrying userinfo, a path, a query, or a hash — those
// would mean this store's key stopped meaning "the origin this secret is
// bound to" and started silently ignoring parts of a mismatched value,
// mirroring daemon-api-client.ts's same-origin-only Authorization discipline.
function canonicalizeOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.search || url.hash) return null
  return url.origin
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    // Quota exceeded / private-mode storage throw: contract is "never
    // throws", caller treats a false return as "not persisted this time".
    return false
  }
}

function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Contract: never throws.
  }
}

/**
 * Returns the stored reconnect secret iff its origin matches `origin`
 * (after canonicalizing both sides), otherwise null. Never throws: corrupt
 * JSON, a legacy shape, or a canonicalization failure all fall back to null.
 */
export function load(origin: string): string | null {
  const raw = safeGetItem(STORAGE_KEY)
  if (raw === null) return null

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return null
  }

  const result = recordSchema.safeParse(parsedJson)
  if (!result.success) return null

  const canonicalTarget = canonicalizeOrigin(origin)
  const canonicalStored = canonicalizeOrigin(result.data.origin)
  if (canonicalTarget === null || canonicalStored === null) return null
  if (canonicalTarget !== canonicalStored) return null

  return result.data.secret
}

/**
 * Persists `secret` bound to `origin`. Returns false (never throws) when the
 * origin does not canonicalize to a bare origin, or when the underlying
 * localStorage write throws.
 */
export function save(origin: string, secret: string): boolean {
  const canonical = canonicalizeOrigin(origin)
  if (canonical === null || secret.length === 0) return false
  return safeSetItem(STORAGE_KEY, JSON.stringify({ origin: canonical, secret }))
}

/**
 * Clears the stored record, but ONLY if it still matches (origin, secret) —
 * guards against clearing a value a concurrent tab already rotated away from
 * the one that just failed.
 */
export function clearIfMatches(origin: string, secret: string): void {
  if (load(origin) === secret) {
    safeRemoveItem(STORAGE_KEY)
  }
}

/**
 * Clears the stored record, but ONLY if it currently belongs to `origin` —
 * guards against a completion for one origin erasing a DIFFERENT origin's
 * legacy secret that a concurrent tab saved after this call's caller
 * started its attempt (this store holds a single record, not one per
 * origin, so an unconditional clear can hit any origin's secret).
 */
export function clearIfOrigin(origin: string): void {
  if (load(origin) !== null) {
    safeRemoveItem(STORAGE_KEY)
  }
}

export function clear(): void {
  safeRemoveItem(STORAGE_KEY)
}
