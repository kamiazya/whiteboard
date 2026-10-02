/**
 * Lowercase hex of a byte array — the spelling a digest or a random token is
 * written in, declared once so the content-addressed store, the reference
 * cache and the random-id fallbacks cannot disagree about case or padding.
 * Pure and DOM-free, so a shared-layer package may call it where `Buffer` is
 * not available.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
