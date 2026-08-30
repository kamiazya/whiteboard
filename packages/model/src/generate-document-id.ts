// Crockford Base32 alphabet used by the ULID spec (excludes I, L, O, U).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

/**
 * Generates a canonical ULID matching model's `documentIdSchema` — and
 * `workspaceCanonicalIdSchema`, which ADR-0019 gave the same shape on
 * purpose. Both delegate to `ULID_PATTERN`, and the guard against confusing
 * the two is those distinct schemas rather than distinct generators, so a
 * caller minting a workspace id calls this one. (`/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`.)
 *
 * The 48-bit millisecond timestamp is
 * encoded big-endian into the first 10 base32 characters; 80 bits of
 * cryptographic entropy fill the remaining 16.
 *
 * The entropy comes from the CSPRNG, not `Math.random()`. Nothing today
 * treats knowing an id as permission to read the document — authorization is
 * the server's job and must stay that way — but "anyone with the link" is
 * the feature a product of this shape grows, and the day it arrives a
 * predictable id becomes a readable document. Choosing the weaker source
 * costs nothing to avoid now and cannot be retrofitted onto ids already
 * handed out.
 *
 * `globalThis.crypto` rather than `node:crypto`: this is a shared-layer
 * package that must run unchanged on Node, the browser, and Cloudflare
 * Workers, and Web Crypto is a global on all three. A runtime without it
 * throws rather than falling back — silently downgrading the entropy is the
 * one outcome worse than failing to start.
 */
export function generateDocumentId(): string {
  return encodeTime(Date.now()) + encodeRandom()
}

function encodeTime(time: number): string {
  let chars = ''
  let remaining = time
  for (let i = 0; i < TIME_CHARS; i++) {
    const mod = remaining % ENCODING.length
    chars = ENCODING[mod] + chars
    remaining = Math.floor(remaining / ENCODING.length)
  }
  return chars
}

function encodeRandom(): string {
  // One byte per character, taken modulo the alphabet. 256 is a whole
  // multiple of 32, so the mapping is uniform — the same code over a 26- or
  // 36-character alphabet would quietly favour its first letters.
  const bytes = new Uint8Array(RANDOM_CHARS)
  globalThis.crypto.getRandomValues(bytes)
  let chars = ''
  for (const byte of bytes) {
    chars += ENCODING[byte % ENCODING.length]
  }
  return chars
}
