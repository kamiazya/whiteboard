/**
 * Frontiers as text.
 *
 * A saved version is a FRONTIER of the workspace record — the point in its
 * history the version stands for — and both keepers store one as base64 (the
 * daemon in a column, the browser beside its rows as bytes it can encode the
 * same way). One codec — `model`'s, which runs on every runtime this package
 * must — so no keeper reaches for `Buffer` and the shared layer stays
 * `node:*`-free.
 */
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import { decodeFrontiers, encodeFrontiers, type Frontiers } from 'loro-crdt'

export function frontiersToBase64(frontiers: Frontiers): string {
  return bytesToBase64(encodeFrontiers(frontiers))
}

/** Throws on text that is not base64, and whatever `decodeFrontiers` throws on bytes that are not a frontier; callers name the location. */
export function frontiersFromBase64(text: string): Frontiers {
  const bytes = base64ToBytes(text)
  if (bytes === null) throw new Error('frontiers are not base64')
  return decodeFrontiers(bytes)
}
