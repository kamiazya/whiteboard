/**
 * Defensive copy of a byte buffer into a fresh `ArrayBuffer`-backed
 * `Uint8Array`. `new Uint8Array(bytes)` (the array-like overload) always
 * allocates a fresh `ArrayBuffer` — unlike `Uint8Array.from`, whose return
 * type widens to `ArrayBufferLike` and no longer matches canvas-ports' DTOs.
 */
export function cloneBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}
