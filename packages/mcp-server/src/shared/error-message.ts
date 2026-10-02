import { messageOf } from '@kamiazya/whiteboard-model'

/**
 * `messageOf` with this package's fixed fallback, for the call sites that have
 * nothing better to say about a thrown non-Error. Sites that do (a user-facing
 * sentence, or `String(err)`) call `messageOf` from model directly — the one
 * implementation, shared with the browser app, which cannot import this file.
 */
export function errorMessage(error: unknown): string {
  return messageOf(error)
}
