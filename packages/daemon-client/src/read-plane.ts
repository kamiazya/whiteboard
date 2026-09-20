import { z } from 'zod'

/**
 * ADR-0043 decision 3: per-document content keys, derived from a workspace
 * key by HKDF-SHA-256 (RFC 5869) rather than stored. A document's epoch is
 * folded into the derivation, so bumping it alone re-keys that document
 * without touching the workspace key or any sibling document.
 *
 * WebCrypto's HKDF `deriveBits` performs RFC 5869's Extract-then-Expand in
 * one call — hand-rolling an HMAC chain on top of it (the way the act
 * plane's macaroon attenuation does) would be a second, redundant HKDF.
 */

// Judged by tag rather than `instanceof`: a value that crossed a structured
// clone (IndexedDB, postMessage) can be a Uint8Array built by another
// realm's constructor, which `instanceof` silently rejects.
//
// Pinned to Uint8Array<ArrayBuffer> (narrower than the default
// Uint8Array<ArrayBufferLike>, which also admits a SharedArrayBuffer-backed
// view): WebCrypto's BufferSource parameters require it, and every byte
// field here either comes from `crypto.getRandomValues`/`subtle.*` or an
// IndexedDB record, neither of which is ever SharedArrayBuffer-backed.
function uint8ArraySchema(exactLength?: number) {
  return z.custom<Uint8Array<ArrayBuffer>>((v) => {
    if (!(ArrayBuffer.isView(v) && Object.prototype.toString.call(v) === '[object Uint8Array]')) {
      return false
    }
    return exactLength === undefined || (v as Uint8Array).length === exactLength
  })
}

export const epochSchema = z.number().int().nonnegative()

const AES_GCM_IV_BYTES = 12

/** Persisted read-plane ciphertext envelope. `v` guards future shape changes. */
export const sealedEnvelopeSchema = z
  .object({
    v: z.literal(1),
    iv: uint8ArraySchema(AES_GCM_IV_BYTES),
    ct: uint8ArraySchema(),
    epoch: epochSchema,
  })
  .strict()

export type SealedEnvelope = z.infer<typeof sealedEnvelopeSchema>

export interface DocumentKeyContext {
  documentId: string
  epoch: number
}

const textEncoder = new TextEncoder()

// A JSON array's own delimiters mark each element's boundary, so
// (documentId, epoch) pairs that would collide under bare string
// concatenation ("a1" + "2" === "a" + "12") encode distinctly.
function contextBytes(tag: string, { documentId, epoch }: DocumentKeyContext) {
  return textEncoder.encode(JSON.stringify([tag, documentId, epoch]))
}

const WORKSPACE_KEY_BYTES = 32
const DERIVED_KEY_BITS = 256

export interface DeriveDocumentKeyInput extends DocumentKeyContext {
  workspaceKey: Uint8Array<ArrayBuffer>
  workspaceKeySalt: Uint8Array<ArrayBuffer>
}

/**
 * Test-only escape hatch to the raw derived bytes (for golden-vector
 * cross-checking against an independent HKDF implementation). Production
 * callers use `deriveDocumentKey`, which never lets the bytes leave
 * WebCrypto's non-extractable key wrapper.
 */
export async function deriveDocumentKeyBytes({
  workspaceKey,
  workspaceKeySalt,
  ...context
}: DeriveDocumentKeyInput): Promise<Uint8Array<ArrayBuffer>> {
  if (workspaceKey.length !== WORKSPACE_KEY_BYTES) {
    throw new RangeError(
      `workspaceKey must be ${WORKSPACE_KEY_BYTES} bytes, got ${workspaceKey.length}`,
    )
  }
  const hkdfKey = await crypto.subtle.importKey('raw', workspaceKey, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: workspaceKeySalt,
      info: contextBytes('wb-doc-key-v1', context),
    },
    hkdfKey,
    DERIVED_KEY_BITS,
  )
  return new Uint8Array(bits)
}

/** Derives a non-extractable AES-256-GCM key scoped to one document+epoch. */
export async function deriveDocumentKey(input: DeriveDocumentKeyInput): Promise<CryptoKey> {
  const bits = await deriveDocumentKeyBytes(input)
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Seals plaintext under a document key. `aad` binds the ciphertext to the
 * (documentId, epoch) it was sealed for, so a caller that opens it under a
 * different document or a bumped epoch is refused even if it somehow holds
 * a key that would otherwise decrypt the bytes.
 */
export async function sealBytes(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  context: DocumentKeyContext,
): Promise<SealedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: contextBytes('wb-doc-aad-v1', context) },
      key,
      plaintext,
    ),
  )
  return { v: 1, iv, ct, epoch: context.epoch }
}

/** Opens an envelope sealed by `sealBytes`. Rejects (OperationError) on any tamper. */
export async function openBytes(
  key: CryptoKey,
  envelope: SealedEnvelope,
  context: DocumentKeyContext,
): Promise<Uint8Array<ArrayBuffer>> {
  const parsed = sealedEnvelopeSchema.parse(envelope)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: parsed.iv, additionalData: contextBytes('wb-doc-aad-v1', context) },
    key,
    parsed.ct,
  )
  return new Uint8Array(plaintext)
}
