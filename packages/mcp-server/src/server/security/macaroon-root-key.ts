/**
 * The macaroon root key: the one secret every act-plane token in this daemon
 * chains from ([ADR-0043](../../../../../docs/contributing/adr/0043-authority-as-keys.md)
 * decision 4's `rootKey`).
 *
 * Shape, lifetime and failure posture are `daemon-identity.ts`'s, deliberately
 * — a Zod-validated JSON record, owner-only, written through a temp file and
 * renamed so a half-written secret is never observed, regenerated when the
 * file cannot be read.
 *
 * **Regeneration is a rotation, and a rotation invalidates every macaroon
 * ever issued.** `verifyMacaroon` recomputes the chain from this key, so a
 * token minted under the old one stops verifying the moment a new one is
 * generated — every agent and every attenuated token has to be reissued.
 * That is the intended behaviour and it is also this file's bluntest
 * instrument: it is the only way to revoke an act-plane token before it
 * expires, and it revokes ALL of them. ADR-0043 decision 4 rejects a
 * deny-list as the finer-grained alternative, so short lifetimes are what
 * stands between an ordinary revocation and this.
 *
 * Losing the file therefore costs reissuance, never a dead daemon. The
 * threat boundary is `daemon-identity.ts`'s: a process that can bind a
 * loopback port but cannot read this data dir. A full-privilege local
 * attacker reads the key and is out of scope — the daemon already trusts
 * the OS user boundary.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getLogger } from '../log.js'
import { assertSecretFileIsOwnerOnly, writeSecretFileAtomicSync } from './secret-file-mode.js'

const log = getLogger('macaroon-root-key')

export const MACAROON_ROOT_KEY_FILENAME = 'macaroon-root-key.json'

// 32 bytes: HMAC-SHA-256's block-independent sweet spot — a key at the hash's
// output length, so it is neither padded nor pre-hashed by the HMAC
// construction.
const ROOT_KEY_BYTES = 32

const rootKeyFileSchema = z
  .object({
    version: z.literal(1),
    alg: z.literal('HMAC-SHA-256'),
    rootKey: z.string().min(1),
  })
  .loose()

export interface MacaroonRootKey {
  /** Raw 32-byte HMAC key. Never logged, never leaves the process. */
  readonly rootKey: Uint8Array
}

function tryLoad(filepath: string): Uint8Array | null {
  let raw: string
  try {
    raw = readFileSync(filepath, 'utf8')
  } catch {
    return null
  }
  let reason: 'invalid-json' | 'invalid-shape' | 'wrong-length'
  try {
    const parsed = rootKeyFileSchema.parse(JSON.parse(raw))
    const bytes = Buffer.from(parsed.rootKey, 'base64url')
    if (bytes.length === ROOT_KEY_BYTES) return new Uint8Array(bytes)
    reason = 'wrong-length'
  } catch (err) {
    // Deliberately NOT logging the error object, for `daemon-identity.ts`'s
    // reason: the parsed JSON carries the key, and a validation error can
    // echo parts of its input. The reason class is enough to act on.
    reason = err instanceof SyntaxError ? 'invalid-json' : 'invalid-shape'
  }
  log.warning(
    { reason },
    'macaroon root key unreadable; generating a fresh one (every issued token stops verifying)',
  )
  return null
}

function generateAndPersist(filepath: string): Uint8Array {
  const key = new Uint8Array(randomBytes(ROOT_KEY_BYTES))
  const record = {
    version: 1,
    alg: 'HMAC-SHA-256',
    rootKey: Buffer.from(key).toString('base64url'),
  }
  writeSecretFileAtomicSync(filepath, `${JSON.stringify(record, null, 2)}\n`)
  return key
}

export function createMacaroonRootKey({ dataDir }: { dataDir: string }): MacaroonRootKey {
  const filepath = join(dataDir, MACAROON_ROOT_KEY_FILENAME)
  // Before the read, not inside `tryLoad`: an unreadable key is regenerated —
  // a rotation this file's header calls its bluntest instrument — and a
  // LEAKED one must not be silently rotated past. So this propagates rather
  // than folding into the null that means "make a new one".
  assertSecretFileIsOwnerOnly(filepath)
  return { rootKey: tryLoad(filepath) ?? generateAndPersist(filepath) }
}
