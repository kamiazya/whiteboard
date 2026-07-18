// Persists which web origins are trusted to silently reconnect to this
// daemon after a page reload (the "known origin" half of the silent
// reconnect flow — see docs/how-to/connect-to-local-daemon.md).
//
// Deliberately NOT keyed on the Origin header alone: daemon.json (the
// shared daemon Bearer token) is already 0o600-protected against other OS
// users on this machine, so gating reconnect on Origin alone would add
// nothing for a same-user attacker and would WEAKEN the boundary for a
// cross-user one (Origin is a header a same-user process can set to
// anything). Trust here is POSSESSION of a rotating, origin-bound secret
// whose hash — never the plaintext — lives in this file; the plaintext
// lives only in the trusted origin's browser-profile localStorage, which
// carries the same cross-user file-permission protection as daemon.json.
//
// Mirrors daemon-registry.ts's persistence shape: atomic temp+rename+chmod
// write, 0o600 file / 0o700 dir, corrupt file tolerated as empty rather than
// crashing startup.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { DATA_DIR } from '../../shared/data-dir-secure.js'

const WEB_ORIGIN_TRUST_FILENAME = 'trusted-web-origins.json'

// Sliding TTL since last successful use: bounds how long a trusted loopback
// dev origin (e.g. http://localhost:5173, which a *different* project's dev
// server could later reuse) stays silently reconnectable. Revocation (the
// `trust revoke` CLI) covers the remainder of that window.
const TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000

const trustRecordSchema = z.object({
  origin: z.string(),
  secretHash: z.string(),
  trustedAt: z.string(),
  lastUsedAt: z.string(),
})

const trustedWebOriginsFileSchema = z.object({
  schemaVersion: z.literal(1),
  origins: z.array(trustRecordSchema),
})

export type WebOriginTrustRecord = z.infer<typeof trustRecordSchema>
type TrustedWebOriginsFile = z.infer<typeof trustedWebOriginsFileSchema>

const EMPTY_FILE: TrustedWebOriginsFile = { schemaVersion: 1, origins: [] }

export function getWebOriginTrustFilePath(dataDir: string = DATA_DIR): string {
  return join(dataDir, WEB_ORIGIN_TRUST_FILENAME)
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

async function readFileMtime(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.mtimeMs
  } catch {
    return null
  }
}

async function loadFile(path: string): Promise<TrustedWebOriginsFile> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    const parsed = trustedWebOriginsFileSchema.safeParse(raw)
    if (!parsed.success) return EMPTY_FILE
    return parsed.data
  } catch {
    return EMPTY_FILE
  }
}

async function saveFile(path: string, dataDir: string, file: TrustedWebOriginsFile): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const temp = `${path}.tmp`
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
  // Mints a fresh reconnect secret for `origin`, replacing any existing
  // trust record for that exact origin. Returns the plaintext secret once —
  // it is never retrievable again, only its hash is persisted.
  trustOrigin(origin: string): Promise<{ secret: string }>
  // Verifies a presented secret against the current, non-expired trust
  // record for `origin`. Re-reads the on-disk file when it changed since
  // this store last read it, so a revocation made by another process (the
  // CLI) is visible without restarting the daemon.
  verify(origin: string, secret: string): Promise<boolean>
  // Rotates the secret for an already-trusted origin, invalidating the old
  // one immediately. Throws if the origin has no existing trust record.
  rotate(origin: string): Promise<{ secret: string }>
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
  // concurrent add/rotate/revoke calls serialize instead of racing a
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
    const result = writeQueue.then(fn)
    // Swallow rejections in the chain itself (each caller still awaits its
    // own `result` and sees the real error) so one failed write doesn't
    // wedge the queue for every write after it.
    writeQueue = result.catch(() => undefined)
    return result
  }

  async function persist(origins: readonly WebOriginTrustRecord[]): Promise<void> {
    const file: TrustedWebOriginsFile = { schemaVersion: 1, origins: [...origins] }
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

  async function rotate(origin: string): Promise<{ secret: string }> {
    return enqueue(async () => {
      const current = await readCurrent()
      const existing = current.origins.find((o) => o.origin === origin)
      if (!existing) {
        throw new Error(`cannot rotate untrusted origin: ${origin}`)
      }
      const secret = mintSecret()
      const nowIso = new Date(now()).toISOString()
      const record: WebOriginTrustRecord = {
        ...existing,
        secretHash: hashReconnectSecret(secret),
        lastUsedAt: nowIso,
      }
      const nextOrigins = current.origins.map((o) => (o.origin === origin ? record : o))
      await persist(nextOrigins)
      return { secret }
    })
  }

  async function verify(origin: string, secret: string): Promise<boolean> {
    // Read-only path: still goes through readCurrent (not the write queue)
    // so a concurrent write is not blocked by a verify, but readCurrent's
    // mtime check still picks up an out-of-band revoke.
    const current = await readCurrent()
    const record = current.origins.find((o) => o.origin === origin)
    if (!record) return false
    if (!safeHashEqual(record.secretHash, hashReconnectSecret(secret))) return false
    const ageMs = now() - Date.parse(record.lastUsedAt)
    if (ageMs > TRUST_TTL_MS) return false
    return true
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

  return { trustOrigin, verify, rotate, revoke, revokeAll, list }
}
