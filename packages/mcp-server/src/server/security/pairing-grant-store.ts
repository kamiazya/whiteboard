/**
 * Persisted pairing grants: which web ORIGINS the user has explicitly
 * approved on the daemon's own /pair consent page. A grant is durable
 * origin trust (survives restarts); the short-lived session tokens minted
 * against a grant live in memory only (pairing-token-store.ts) — that
 * asymmetry is intentional, per the pairing-grant design review.
 *
 * File format is Zod-validated on load (zod-schema-discipline: persisted
 * JSON hydrates through schema.parse, never a cast). A corrupt or
 * unreadable file degrades to an empty store — losing grants means
 * re-consenting, never a dead daemon.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { getLogger } from '../log.js'

const log = getLogger('pairing-grants')

const PAIRING_GRANTS_FILENAME = 'pairing-grants.json'

const pairingGrantSchema = z
  .object({
    grantId: z.string().min(1),
    origin: z.string().refine((value) => {
      try {
        const url = new URL(value)
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
      } catch {
        return false
      }
    }, 'must be a canonical http(s) origin'),
    createdAt: z.string(),
  })
  .strict()

const pairingGrantsFileSchema = z
  .object({
    version: z.literal(1),
    grants: z.array(pairingGrantSchema),
  })
  .strict()

export type PairingGrant = z.infer<typeof pairingGrantSchema>

export interface PairingGrantStore {
  /** Canonical origins of every persisted grant. Returns a NEW array per
   *  mutation generation (stable while unchanged) so the array-identity
   *  pattern cache in web-origin-allowlist.ts keys correctly. */
  origins(): readonly string[]
  list(): readonly PairingGrant[]
  /** Normalizes to `new URL(input).origin` (never trusts caller spelling —
   *  see the server-mode-exposure note) and deduplicates per origin.
   *  Throws on a non-http(s) or unparseable input. */
  addGrant(originInput: string): PairingGrant
  revoke(grantId: string): boolean
}

export function createPairingGrantStore(dataDir: string): PairingGrantStore {
  const filePath = join(dataDir, PAIRING_GRANTS_FILENAME)

  function load(): PairingGrant[] {
    try {
      const parsed = pairingGrantsFileSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (!parsed.success) {
        log.warning('pairing-grants file failed validation; starting empty')
        return []
      }
      return parsed.data.grants
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warning({ err }, 'pairing-grants file unreadable; starting empty')
      }
      return []
    }
  }

  let grants: PairingGrant[] = load()
  // Regenerated only on mutation — see origins() contract above.
  let originsSnapshot: readonly string[] = grants.map((grant) => grant.origin)

  function persist(): void {
    const payload = JSON.stringify({ version: 1, grants }, null, 2)
    // Write-then-rename so a crash mid-write never leaves a truncated file
    // that would silently drop every grant on the next load.
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, payload, { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  return {
    origins: () => originsSnapshot,
    list: () => [...grants],
    addGrant(originInput: string): PairingGrant {
      let origin: string
      try {
        origin = new URL(originInput).origin
      } catch {
        throw new Error('pairing grant requires a valid URL')
      }
      if (!origin.startsWith('http:') && !origin.startsWith('https:')) {
        throw new Error('pairing grant requires an http(s) origin')
      }
      const existing = grants.find((grant) => grant.origin === origin)
      if (existing) return existing
      const grant: PairingGrant = {
        grantId: nanoid(),
        origin,
        createdAt: new Date().toISOString(),
      }
      grants = [...grants, grant]
      originsSnapshot = grants.map((entry) => entry.origin)
      persist()
      return grant
    },
    revoke(grantId: string): boolean {
      const next = grants.filter((grant) => grant.grantId !== grantId)
      if (next.length === grants.length) return false
      grants = next
      originsSnapshot = grants.map((entry) => entry.origin)
      persist()
      return true
    },
  }
}
