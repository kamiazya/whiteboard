/**
 * The daemon's durable identity keypair — the trust anchor that lets a
 * browser verify a loopback responder is the real daemon (and not a
 * port-squatting local process). The public key is pinned by the web app at
 * /pair consent time; every later signature is verified against that pin,
 * so a squatter advertising its own key gains nothing.
 *
 * Threat boundary: defends against a process that can bind a loopback port
 * but cannot read this data dir. A full-privilege local attacker can read
 * the private key and is out of scope — the daemon already trusts the OS
 * user boundary.
 *
 * A corrupt or unreadable file regenerates a fresh keypair (rotation
 * semantics): paired browsers fail closed on the key mismatch and require a
 * fresh /pair approval, which re-pins. Losing the file costs re-approval
 * clicks, never a dead daemon.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { getLogger } from '../log.js'

const log = getLogger('daemon-identity')

const DAEMON_IDENTITY_FILENAME = 'daemon-identity.json'

const ed25519JwkSchema = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().min(1),
    d: z.string().min(1).optional(),
  })
  .loose()

const identityFileSchema = z
  .object({
    version: z.literal(1),
    alg: z.literal('Ed25519'),
    publicJwk: ed25519JwkSchema,
    privateJwk: ed25519JwkSchema.refine((jwk) => jwk.d !== undefined, 'private JWK must carry d'),
  })
  .loose()

export interface DaemonIdentity {
  readonly alg: 'Ed25519'
  /** Raw 32-byte Ed25519 public key, base64url. */
  readonly publicKey: string
  /** Signs a domain-separated message; returns the signature base64url. */
  readonly sign: (parts: readonly string[]) => string
}

// JSON-array encoding gives unambiguous part boundaries: ["ab","c"] and
// ["a","bc"] serialize differently, so no length-prefixing scheme is needed.
// The first part is always a domain-separation tag ("wb-verify-v1", ...).
export function buildSignedPayload(parts: readonly string[]): Buffer {
  return Buffer.from(JSON.stringify(parts), 'utf8')
}

interface LoadedKeys {
  publicKey: KeyObject
  privateKey: KeyObject
}

function tryLoad(filepath: string): LoadedKeys | null {
  let raw: string
  try {
    raw = readFileSync(filepath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = identityFileSchema.parse(JSON.parse(raw))
    return {
      publicKey: createPublicKey({ key: parsed.publicJwk, format: 'jwk' }),
      privateKey: createPrivateKey({ key: parsed.privateJwk, format: 'jwk' }),
    }
  } catch (err) {
    log.warning({ err }, 'daemon identity file unreadable; generating a fresh keypair')
    return null
  }
}

function generateAndPersist(filepath: string): LoadedKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const record = {
    version: 1,
    alg: 'Ed25519',
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  }
  // Write-then-rename with owner-only perms, same posture as the pairing
  // grants file: a half-written identity must never be observed, and the
  // private key is never group/world readable.
  // The data dir may not exist yet on a first start (identity generation can
  // precede any store write); owner-only like the rest of the data dir.
  mkdirSync(dirname(filepath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filepath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmpPath, filepath)
  return { publicKey, privateKey }
}

export function createDaemonIdentity({ dataDir }: { dataDir: string }): DaemonIdentity {
  const filepath = join(dataDir, DAEMON_IDENTITY_FILENAME)
  const keys = tryLoad(filepath) ?? generateAndPersist(filepath)

  const publicJwk = keys.publicKey.export({ format: 'jwk' }) as { x?: string }
  const publicKeyB64u = publicJwk.x
  if (publicKeyB64u === undefined) {
    // Unreachable for a well-formed Ed25519 key; guard so a broken export
    // fails loudly at startup instead of advertising an empty identity.
    throw new Error('daemon identity public key export produced no key material')
  }

  return {
    alg: 'Ed25519',
    publicKey: publicKeyB64u,
    sign: (parts) =>
      cryptoSign(null, buildSignedPayload(parts), keys.privateKey).toString('base64url'),
  }
}
