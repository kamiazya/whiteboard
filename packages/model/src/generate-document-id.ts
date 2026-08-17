// Crockford Base32 alphabet used by the ULID spec (excludes I, L, O, U).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

/**
 * Generates a canonical ULID matching model's `documentIdSchema`
 * (`/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`). The 48-bit millisecond timestamp is
 * encoded big-endian into the first 10 base32 characters; 80 bits of
 * `Math.random()`-derived entropy fill the remaining 16. Uses
 * `Date.now()`/`Math.random()` only (no `node:crypto`) so this stays valid
 * in a shared-layer package that must run unchanged on Node, the browser,
 * and Cloudflare Workers.
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
  let chars = ''
  for (let i = 0; i < RANDOM_CHARS; i++) {
    chars += ENCODING[Math.floor(Math.random() * ENCODING.length)]
  }
  return chars
}
