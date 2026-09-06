/**
 * Frontiers as text.
 *
 * A branch tip and a saved version are both a FRONTIER of the workspace
 * record — the point in its history the name stands for — and both keepers
 * store one as base64 (the daemon in a column, the browser beside its rows
 * as bytes it can encode the same way). One codec here, over the base64
 * primitives every runtime this package must run on has (`atob`/`btoa` in
 * the browser, in Node since 16, and in a worker), so no keeper reaches for
 * `Buffer` and the shared layer stays `node:*`-free.
 */
import { decodeFrontiers, encodeFrontiers, type Frontiers } from 'loro-crdt'

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked: `String.fromCharCode(...bytes)` overflows the argument list on
  // a frontier of any real size.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function frontiersToBase64(frontiers: Frontiers): string {
  return bytesToBase64(encodeFrontiers(frontiers))
}

/** Throws whatever `decodeFrontiers` throws on bytes that are not a frontier; callers name the location. */
export function frontiersFromBase64(text: string): Frontiers {
  return decodeFrontiers(base64ToBytes(text))
}
