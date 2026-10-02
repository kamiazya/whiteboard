import { z } from 'zod'

/**
 * Whether `value` is a genuine `Uint8Array`, whichever realm built it.
 *
 * `instanceof` is the wrong test for bytes that crossed a structured clone
 * (IndexedDB, `postMessage`): an implementation may build them with another
 * realm's constructor — jsdom's `fake-indexeddb` does — and `instanceof` then
 * rejects a perfectly good record as corrupt. The `Object.prototype.toString`
 * tag crosses realms, but it is spoofable by any plain object carrying
 * `Symbol.toStringTag`, and `new Uint8Array(spoof)` yields empty bytes
 * instead of a refusal. `ArrayBuffer.isView` reads the internal typed-array
 * slot, also holds across realms, and is what proves the value is a real view
 * rather than an object wearing the name — so both are required.
 *
 * This module is the only place the tag is spelled; a scan in `arch-lint`
 * holds it so a weaker copy cannot reappear.
 */
export function isUint8ArrayAnyRealm(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]')
  )
}

/**
 * `isUint8ArrayAnyRealm` as a schema; the value passes through uncopied.
 *
 * Typed `Uint8Array<ArrayBuffer>`, narrower than the default
 * `Uint8Array<ArrayBufferLike>` (which also admits a `SharedArrayBuffer`-backed
 * view): WebCrypto's `BufferSource` parameters require it, and every byte field
 * parsed through this schema comes from `crypto.*` or a structured clone, never
 * from a shared buffer. A caller that must own its copy (so `loro.import` sees
 * an array of its own realm) copies in a `.transform`.
 */
export const uint8ArrayAnyRealmSchema = z.custom<Uint8Array<ArrayBuffer>>(isUint8ArrayAnyRealm)
