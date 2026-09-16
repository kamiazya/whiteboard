/**
 * Persisted WebAuthn credential PINS: the public key of each passkey a paired
 * origin registered, so a later assertion is verified against the key the
 * daemon recorded and never against one the request brings (ADR-0039). The
 * daemon-side twin of the browser's `daemon-identity-pin.ts`, and kept the
 * way `pairing-grant-store.ts` keeps origin grants: a Zod-validated JSON file
 * under the data dir, written owner-only through a rename, degrading to
 * empty when unreadable — losing pins means registering again, never a dead
 * daemon.
 *
 * A pin is keyed by ORIGIN and credential id. A credential is scoped to a
 * relying party, so the same id can only recur across origins by accident of
 * another authenticator, and a lookup that ignored the origin would let a
 * key pinned by one origin vouch for a request from another.
 *
 * `backupEligible` is recorded from the registration (decision 3) and
 * `signCount` from the last accepted assertion, so a non-monotonic count — a
 * cloned authenticator, or a replayed assertion — can be refused where the
 * spec says to check it (§6.1.1: only meaningful when either count is
 * non-zero; synced passkeys report 0 for life).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getLogger } from '../log.js'
import { p256PublicKeyJwkSchema } from './webauthn-assertion.js'

const log = getLogger('webauthn-credentials')

const CREDENTIALS_FILENAME = 'webauthn-credentials.json'

const pinnedCredentialSchema = z
  .object({
    credentialId: z.string().min(1),
    origin: z.string().min(1),
    rpId: z.string().min(1),
    publicKeyJwk: p256PublicKeyJwkSchema,
    backupEligible: z.boolean(),
    signCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict()

const credentialsFileSchema = z
  .object({
    version: z.literal(1),
    credentials: z.array(pinnedCredentialSchema),
  })
  .strict()

export type PinnedCredential = z.infer<typeof pinnedCredentialSchema>

type CredentialRegistration = Omit<PinnedCredential, 'createdAt'>

export interface WebAuthnCredentialStore {
  list(): readonly PinnedCredential[]
  find(origin: string, credentialId: string): PinnedCredential | null
  /** Pins a credential; a second registration of the same one REPLACES the pin. */
  register(input: CredentialRegistration): PinnedCredential
  /**
   * Records the count an accepted assertion carried. False — and nothing
   * recorded — when the credential is unknown or the count did not advance
   * while either side is non-zero.
   */
  recordSignCount(origin: string, credentialId: string, signCount: number): boolean
  revoke(origin: string, credentialId: string): boolean
}

export function createWebAuthnCredentialStore(dataDir: string): WebAuthnCredentialStore {
  const filePath = join(dataDir, CREDENTIALS_FILENAME)

  function load(): PinnedCredential[] {
    try {
      const parsed = credentialsFileSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (!parsed.success) {
        log.warning('webauthn-credentials file failed validation; starting empty')
        return []
      }
      return parsed.data.credentials
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warning({ err }, 'webauthn-credentials file unreadable; starting empty')
      }
      return []
    }
  }

  let credentials: PinnedCredential[] = load()

  function persist(): void {
    const payload = JSON.stringify({ version: 1, credentials }, null, 2)
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, payload, { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  const same = (pin: PinnedCredential, origin: string, credentialId: string) =>
    pin.origin === origin && pin.credentialId === credentialId

  return {
    list: () => [...credentials],
    find(origin, credentialId) {
      return credentials.find((pin) => same(pin, origin, credentialId)) ?? null
    },
    register(input) {
      const pin: PinnedCredential = { ...input, createdAt: new Date().toISOString() }
      credentials = [
        ...credentials.filter((existing) => !same(existing, input.origin, input.credentialId)),
        pin,
      ]
      persist()
      return pin
    },
    recordSignCount(origin, credentialId, signCount) {
      const pin = credentials.find((existing) => same(existing, origin, credentialId))
      if (pin === undefined) return false
      const counted = signCount !== 0 || pin.signCount !== 0
      if (counted && signCount <= pin.signCount) return false
      credentials = credentials.map((existing) =>
        existing === pin ? { ...existing, signCount } : existing,
      )
      persist()
      return true
    },
    revoke(origin, credentialId) {
      const next = credentials.filter((existing) => !same(existing, origin, credentialId))
      if (next.length === credentials.length) return false
      credentials = next
      persist()
      return true
    },
  }
}
