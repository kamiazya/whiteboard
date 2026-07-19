// Persists which web origins are trusted to silently reconnect to this
// daemon after a page reload (the "known origin" half of the silent
// reconnect flow — see docs/how-to/connect-to-local-daemon.md).
//
// Deliberately NOT keyed on the Origin header alone: daemon.json (the
// shared daemon Bearer token) is already 0o600-protected against other OS
// users on this machine, so gating reconnect on Origin alone would add
// nothing for a same-user attacker and would WEAKEN the boundary for a
// cross-user one (Origin is a header a same-user process can set to
// anything). Trust here is POSSESSION of a credential whose public half (an
// ECDSA P-256 public key) or hash (a legacy rotating secret, grace-period
// only) lives in this file; the matching private key or secret plaintext
// lives only in the trusted origin's browser profile, which carries the
// same cross-user file-permission protection as daemon.json.
//
// Mirrors daemon-registry.ts's persistence shape: atomic temp+rename+chmod
// write, 0o600 file / 0o700 dir, corrupt file tolerated as empty rather than
// crashing startup.

import { createHash, randomBytes, timingSafeEqual, webcrypto } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'
import { pid } from 'node:process'
import { z } from 'zod'
import {
  type EcP256PublicJwk,
  ecP256PublicJwkSchema,
} from '../../shared/api-contracts/reconnect.js'
import { DATA_DIR } from '../../shared/data-dir-secure.js'
import { withMkdirLock } from '../../shared/mkdir-lock.js'

const WEB_ORIGIN_TRUST_FILENAME = 'trusted-web-origins.json'
const WEB_ORIGIN_TRUST_LOCK_DIRNAME = 'trusted-web-origins.lock'

// Sliding TTL since last successful use: bounds how long a trusted loopback
// dev origin (e.g. http://localhost:5173, which a *different* project's dev
// server could later reuse) stays silently reconnectable. Revocation (the
// `trust revoke` CLI) covers the remainder of that window.
//
// Exported so callers reporting this TTL to a client (reconnect.ts's
// `expiresInDays`) derive it from the single value actually enforced here,
// instead of maintaining a second hardcoded constant that can silently
// desync from the real enforcement.
export const TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000

// Absolute cap on the legacy Bearer-secret grace period, measured from
// trustedAt rather than the sliding lastUsedAt: a legacy secret is a
// migration-compatibility shim, never rotated, so periodic use alone (which
// keeps the SLIDING TTL above perpetually fresh) must not let it stay
// silently reconnectable forever. Deliberately NOT applied to
// verifySignedChallenge — an enrolled public-key credential is the intended
// long-term path and is governed by the sliding TTL alone.
export const LEGACY_SECRET_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000

const trustRecordSchemaV2Base = z.object({
  origin: z.string(),
  publicKeyJwk: ecP256PublicJwkSchema.optional(),
  secretHash: z.string().optional(),
  trustedAt: z.string(),
  lastUsedAt: z.string(),
})

// A record must carry at least one credential — either a public key or a
// legacy secret hash (the grace-period path) — or it is a state this store
// never intentionally produces and is treated as corrupt.
const trustRecordSchema = trustRecordSchemaV2Base.superRefine((record, ctx) => {
  if (!record.publicKeyJwk && !record.secretHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'record must have at least one of publicKeyJwk or secretHash',
    })
  }
})

const trustedWebOriginsFileSchemaV2 = z.object({
  schemaVersion: z.literal(2),
  origins: z.array(trustRecordSchema),
})

// v1 records were secretHash-only, unconditionally — loading one never
// requires the superRefine above (a v1 file that made it to disk always had
// a secretHash).
const trustRecordSchemaV1 = z.object({
  origin: z.string(),
  secretHash: z.string(),
  trustedAt: z.string(),
  lastUsedAt: z.string(),
})
const trustedWebOriginsFileSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  origins: z.array(trustRecordSchemaV1),
})

type WebOriginTrustRecord = z.infer<typeof trustRecordSchema>
type TrustedWebOriginsFile = z.infer<typeof trustedWebOriginsFileSchemaV2>

const EMPTY_FILE: TrustedWebOriginsFile = { schemaVersion: 2, origins: [] }

export function getWebOriginTrustFilePath(dataDir: string = DATA_DIR): string {
  return join(dataDir, WEB_ORIGIN_TRUST_FILENAME)
}

function getWebOriginTrustLockPath(dataDir: string): string {
  return join(dataDir, WEB_ORIGIN_TRUST_LOCK_DIRNAME)
}

export function hashReconnectSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function mintSecret(): string {
  return randomBytes(32).toString('base64url')
}

function safeHashEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

function jwkEquals(a: EcP256PublicJwk, b: EcP256PublicJwk): boolean {
  return a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y
}

async function importVerifyKey(jwk: EcP256PublicJwk): Promise<webcrypto.CryptoKey> {
  return webcrypto.subtle.importKey(
    'jwk',
    { ...jwk, ext: true, key_ops: ['verify'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

// P1363 (r||s) verification, matching what browser crypto.subtle.sign
// produces — node:crypto's legacy createVerify() speaks DER instead, and
// silently swapping to it here would break every real client signature
// while unit tests that mint their own DER fixtures kept passing.
async function verifyP1363Signature(
  jwk: EcP256PublicJwk,
  message: string,
  signature: Buffer,
): Promise<boolean> {
  try {
    const key = await importVerifyKey(jwk)
    return await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      new TextEncoder().encode(message),
    )
  } catch {
    return false
  }
}

// The schema only checks field names and decoded coordinate byte lengths —
// it cannot tell a 32-byte (x, y) pair that sits on the P-256 curve from one
// that doesn't. Actually importing the key is the only way to catch that,
// so enrollment attempts it before persisting rather than deferring the
// failure to the first signature verification against a key that can never
// import successfully.
export async function isImportableP256PublicKey(jwk: EcP256PublicJwk): Promise<boolean> {
  try {
    await importVerifyKey(jwk)
    return true
  } catch {
    return false
  }
}

async function readFileMtime(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.mtimeMs
  } catch {
    return null
  }
}

function migrateV1(file: z.infer<typeof trustedWebOriginsFileSchemaV1>): TrustedWebOriginsFile {
  return {
    schemaVersion: 2,
    origins: file.origins.map((record) => ({
      origin: record.origin,
      secretHash: record.secretHash,
      trustedAt: record.trustedAt,
      lastUsedAt: record.lastUsedAt,
    })),
  }
}

async function loadFile(path: string): Promise<TrustedWebOriginsFile> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    const v2 = trustedWebOriginsFileSchemaV2.safeParse(raw)
    if (v2.success) return v2.data
    const v1 = trustedWebOriginsFileSchemaV1.safeParse(raw)
    if (v1.success) return migrateV1(v1.data)
    return EMPTY_FILE
  } catch {
    return EMPTY_FILE
  }
}

async function saveFile(path: string, dataDir: string, file: TrustedWebOriginsFile): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  // Multiple OS processes write this exact file concurrently (this daemon on
  // trustOrigin()/enrollPublicKey(), the separate `whiteboard trust revoke`
  // CLI on its own process) while sharing the same on-disk path. A literal
  // `${path}.tmp` with no per-process suffix lets two writers interleave
  // writes to, or race the rename of, the same temp file — a PID + random
  // suffix keeps each writer's temp file unique so only the atomic rename
  // can interleave, never the write.
  const temp = `${path}.${pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(file, null, 2), { mode: 0o600 })
  await rename(temp, path)
  if (platform() !== 'win32') {
    try {
      await chmod(path, 0o600)
    } catch {
      /* Best-effort only; startup should continue even if this fails. */
    }
  }
}

export interface WebOriginTrustStore {
  // Mints a fresh legacy reconnect secret for `origin`, replacing any
  // existing trust record for that exact origin. Returns the plaintext
  // secret once — it is never retrievable again, only its hash is
  // persisted. No production caller mints new legacy secrets today (every
  // remaining call site is a test exercising the legacy grace path); kept as
  // the fallback bootstrap primitive for a caller that cannot yet perform
  // WebCrypto keypair enrollment. Overwrites unconditionally, including
  // stripping any `publicKeyJwk` already on the record — do not call this
  // against an origin that holds an enrolled keypair without accepting that
  // downgrade.
  trustOrigin(origin: string): Promise<{ secret: string }>
  // Enrolls (or replaces) the public-key credential for `origin`, dropping
  // any legacy secretHash on that record. Idempotent for an identical, still
  // FRESH JWK — re-enrolling the same key before its sliding TTL lapses is a
  // no-op rather than bumping trustedAt/lastUsedAt. Re-enrolling the same key
  // AFTER it expired renews lastUsedAt (treated as a fresh re-pair) rather
  // than staying permanently expired despite a successful re-pair.
  enrollPublicKey(origin: string, jwk: EcP256PublicJwk): Promise<void>
  // Verifies a P1363 ECDSA signature over `nonce` against `origin`'s
  // enrolled public key. The cryptographic verify happens first (no lock
  // held — it is the slow, async step); only once it succeeds does this
  // re-check, under the write queue, that the record still exists, is
  // unexpired, unrevoked, and still holds the SAME public key it verified
  // against — closing the gap where a revoke or re-enroll lands mid-verify.
  // Only on passing both checks is `lastUsedAt` touched (sliding TTL) and
  // `true` returned.
  verifySignedChallenge(origin: string, nonce: string, signature: string): Promise<boolean>
  // Verifies a presented legacy secret against the current, non-expired
  // trust record for `origin`, touching `lastUsedAt` on success. NO
  // rotation — the legacy secret stays valid for repeated use through the
  // grace period, same as a public-key credential would.
  verifyLegacySecret(origin: string, secret: string): Promise<boolean>
  revoke(origin: string): Promise<void>
  revokeAll(): Promise<void>
  list(): Promise<readonly WebOriginTrustRecord[]>
}

export interface WebOriginTrustStoreOptions {
  dataDir?: string
  now?: () => number
}

export function createWebOriginTrustStore(
  options: WebOriginTrustStoreOptions = {},
): WebOriginTrustStore {
  const dataDir = options.dataDir ?? DATA_DIR
  const now = options.now ?? Date.now
  const path = getWebOriginTrustFilePath(dataDir)

  // Single-writer queue: every mutating call chains onto this promise so
  // concurrent add/enroll/revoke calls serialize instead of racing a
  // read-modify-write against the same file.
  let writeQueue: Promise<unknown> = Promise.resolve()
  let cachedMtime: number | null = null
  let cached: TrustedWebOriginsFile = EMPTY_FILE

  async function readCurrent(): Promise<TrustedWebOriginsFile> {
    const mtime = await readFileMtime(path)
    if (mtime === null) {
      cachedMtime = null
      cached = EMPTY_FILE
      return cached
    }
    if (mtime !== cachedMtime) {
      cached = await loadFile(path)
      cachedMtime = mtime
    }
    return cached
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // The in-process writeQueue only orders calls within this one store
    // instance. A separate process (the daemon and the `whiteboard trust`
    // CLI both mutate this same file) can read the current record set
    // between this instance's own read and write — its later persist()
    // would then overwrite the whole file from that stale read, discarding
    // whatever this instance just wrote (e.g. a CLI revoke undone by a
    // daemon enrollment that read before the revoke landed). Holding the
    // mkdir-based cross-process lock for the whole read-modify-write
    // closes that gap: readCurrent() inside `fn` only ever sees state no
    // other process is concurrently about to overwrite.
    const result = writeQueue.then(async () => {
      await mkdir(dataDir, { recursive: true })
      return withMkdirLock(getWebOriginTrustLockPath(dataDir), fn)
    })
    // Swallow rejections in the chain itself (each caller still awaits its
    // own `result` and sees the real error) so one failed write doesn't
    // wedge the queue for every write after it.
    writeQueue = result.catch(() => undefined)
    return result
  }

  async function persist(origins: readonly WebOriginTrustRecord[]): Promise<void> {
    const file: TrustedWebOriginsFile = { schemaVersion: 2, origins: [...origins] }
    await saveFile(path, dataDir, file)
    cached = file
    cachedMtime = (await readFileMtime(path)) ?? null
  }

  async function trustOrigin(origin: string): Promise<{ secret: string }> {
    return enqueue(async () => {
      const current = await readCurrent()
      const secret = mintSecret()
      const nowIso = new Date(now()).toISOString()
      const record: WebOriginTrustRecord = {
        origin,
        secretHash: hashReconnectSecret(secret),
        trustedAt: nowIso,
        lastUsedAt: nowIso,
      }
      const nextOrigins = [...current.origins.filter((o) => o.origin !== origin), record]
      await persist(nextOrigins)
      return { secret }
    })
  }

  async function enrollPublicKey(origin: string, jwk: EcP256PublicJwk): Promise<void> {
    await enqueue(async () => {
      const current = await readCurrent()
      const existing = current.origins.find((o) => o.origin === origin)
      if (
        existing?.publicKeyJwk &&
        jwkEquals(existing.publicKeyJwk, jwk) &&
        isRecordFresh(existing)
      ) {
        return // idempotent no-op — keep trustedAt/lastUsedAt as-is.
      }
      const nowIso = new Date(now()).toISOString()
      const record: WebOriginTrustRecord = {
        origin,
        publicKeyJwk: jwk,
        trustedAt: existing?.trustedAt ?? nowIso,
        lastUsedAt: nowIso,
      }
      const nextOrigins = [...current.origins.filter((o) => o.origin !== origin), record]
      await persist(nextOrigins)
    })
  }

  function isRecordFresh(record: WebOriginTrustRecord): boolean {
    const ageMs = now() - Date.parse(record.lastUsedAt)
    return ageMs <= TRUST_TTL_MS
  }

  function isWithinLegacySecretAbsoluteTtl(record: WebOriginTrustRecord): boolean {
    const ageMs = now() - Date.parse(record.trustedAt)
    return ageMs <= LEGACY_SECRET_ABSOLUTE_TTL_MS
  }

  async function verifySignedChallenge(
    origin: string,
    nonce: string,
    signatureB64Url: string,
  ): Promise<boolean> {
    const current = await readCurrent()
    const record = current.origins.find((o) => o.origin === origin)
    if (!record?.publicKeyJwk) return false
    if (!isRecordFresh(record)) return false

    let signature: Buffer
    try {
      signature = Buffer.from(signatureB64Url, 'base64url')
    } catch {
      return false
    }
    if (signature.length !== 64) return false

    const verified = await verifyP1363Signature(record.publicKeyJwk, nonce, signature)
    if (!verified) return false

    const capturedJwk = record.publicKeyJwk
    // Re-check under the write queue: a revoke or re-enroll landing during
    // the async crypto verify above must not let this call still mint a
    // token off the now-stale state it read before verifying.
    return enqueue(async () => {
      const latest = await readCurrent()
      const latestRecord = latest.origins.find((o) => o.origin === origin)
      if (!latestRecord?.publicKeyJwk) return false
      if (!jwkEquals(latestRecord.publicKeyJwk, capturedJwk)) return false
      if (!isRecordFresh(latestRecord)) return false

      const nowIso = new Date(now()).toISOString()
      const updated: WebOriginTrustRecord = { ...latestRecord, lastUsedAt: nowIso }
      const nextOrigins = latest.origins.map((o) => (o.origin === origin ? updated : o))
      await persist(nextOrigins)
      return true
    })
  }

  async function verifyLegacySecret(origin: string, secret: string): Promise<boolean> {
    return enqueue(async () => {
      const current = await readCurrent()
      const record = current.origins.find((o) => o.origin === origin)
      if (!record?.secretHash) return false
      if (!safeHashEqual(record.secretHash, hashReconnectSecret(secret))) return false
      if (!isRecordFresh(record)) return false
      if (!isWithinLegacySecretAbsoluteTtl(record)) return false

      const nowIso = new Date(now()).toISOString()
      const updated: WebOriginTrustRecord = { ...record, lastUsedAt: nowIso }
      const nextOrigins = current.origins.map((o) => (o.origin === origin ? updated : o))
      await persist(nextOrigins)
      return true
    })
  }

  async function revoke(origin: string): Promise<void> {
    await enqueue(async () => {
      const current = await readCurrent()
      const nextOrigins = current.origins.filter((o) => o.origin !== origin)
      await persist(nextOrigins)
    })
  }

  async function revokeAll(): Promise<void> {
    await enqueue(async () => {
      await persist([])
    })
  }

  async function list(): Promise<readonly WebOriginTrustRecord[]> {
    const current = await readCurrent()
    return current.origins
  }

  return {
    trustOrigin,
    enrollPublicKey,
    verifySignedChallenge,
    verifyLegacySecret,
    revoke,
    revokeAll,
    list,
  }
}
