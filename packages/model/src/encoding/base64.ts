/**
 * The one base64 / base64url codec, over `btoa`/`atob` — globals on Node, in
 * every browser and in a worker, so a shared-layer package may call it and no
 * caller needs `Buffer`. (Verified before adopting: pure, DOM-free, no
 * `node:*`.)
 *
 * Failure contract, the same for both variants: a DECODER answers `null` for
 * text that is not base64 and never throws. Callers that must fail loudly
 * name their own error at the call site, where the location is known; a
 * decoder that throws sends every caller back to writing a try/catch of its
 * own, which is how ten hand-rolled copies came to disagree about it.
 *
 * Grammar accepted (RFC 4648 sections 4 and 5), strictly:
 * - only the variant's alphabet — `+/` for standard, `-_` for url; the other
 *   variant's characters, whitespace and anything else are refused, which
 *   `atob` alone would strip or misread;
 * - padding optional in BOTH variants, but if present it must complete the
 *   last quartet exactly (`Zg==`, never `Zg=` or `Zg===`);
 * - a lone trailing character (length % 4 === 1) carries under 6 bits and
 *   names no byte, so it is refused.
 * Trailing bits of the final character are not required to be zero, matching
 * `atob` and Node; a caller that needs canonical text checks that itself.
 *
 * Encoders: standard is padded, url is unpadded.
 */

/** Chunked: `String.fromCharCode(...bytes)` overflows the argument list on a large array. */
const ENCODE_CHUNK = 0x8000

function bytesToBinary(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + ENCODE_CHUNK))
  }
  return binary
}

const STANDARD_BODY = /^[A-Za-z0-9+/]*$/
const URL_BODY = /^[A-Za-z0-9_-]*$/

function decode(text: string, alphabet: RegExp): Uint8Array<ArrayBuffer> | null {
  const bodyEnd = text.endsWith('==')
    ? text.length - 2
    : text.endsWith('=')
      ? text.length - 1
      : text.length
  const body = text.slice(0, bodyEnd)
  const padding = text.length - bodyEnd
  if (!alphabet.test(body)) return null
  if (body.length % 4 === 1) return null
  if (padding > 0 && (body.length + padding) % 4 !== 0) return null

  const standard = body.replaceAll('-', '+').replaceAll('_', '/')
  // `atob` is the WHATWG forgiving-base64 decode: unpadded input is fine.
  const binary = atob(standard)
  // Over an explicit ArrayBuffer: a bare `new Uint8Array(n)` is typed
  // `Uint8Array<ArrayBufferLike>`, which `BufferSource` refuses because it
  // could be shared.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Standard alphabet, padded. */
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes))
}

/** Url-safe alphabet, no padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Standard alphabet, padded or not. Null when `text` is not base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  return decode(text, STANDARD_BODY)
}

/** Url-safe alphabet, padded or not. Null when `text` is not base64url. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  return decode(text, URL_BODY)
}
