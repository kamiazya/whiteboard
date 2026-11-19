/**
 * Frontiers as text.
 *
 * A saved version is a FRONTIER of the workspace record — the point in its
 * history the version stands for — and both keepers store one as base64 (the
 * daemon in a column, the browser beside its rows as bytes it can encode the
 * same way). One codec — `model`'s, which runs on every runtime this package
 * must — so no keeper reaches for `Buffer` and the shared layer stays
 * `node:*`-free.
 *
 * The bytes are the engine's encoded frontiers and stay opaque here: encoding
 * a frontier and decoding it again belong to whoever holds the engine.
 */
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'

export function frontiersToBase64(encoded: Uint8Array): string {
  return bytesToBase64(encoded)
}

/** Throws on text that is not base64; callers name the location. */
export function frontiersFromBase64(text: string): Uint8Array {
  const bytes = base64ToBytes(text)
  if (bytes === null) throw new Error('frontiers are not base64')
  return bytes
}
