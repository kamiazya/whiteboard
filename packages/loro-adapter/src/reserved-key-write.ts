import { holdsReservedKey, SYNC_TEXT_BREACH_CODES } from '@kamiazya/whiteboard-model'
import { ReservedKeyWrite } from './generated/refusals.js'

/**
 * A value write refused because the value holds a key named `__proto__` —
 * the shape the sync judge refuses as `reserved_map_key`, held at every
 * writer so no write path can store what a sync update may not carry.
 * Thrown before the first op, so nothing of the write was kept.
 */
export class ReservedKeyWriteError extends Error {
  readonly code = SYNC_TEXT_BREACH_CODES['reserved-map-key']

  constructor(readonly container: string) {
    super(ReservedKeyWrite(container))
    this.name = 'ReservedKeyWriteError'
  }
}

/** Throws `ReservedKeyWriteError` when `value`, bound for `container`, holds the reserved key. */
export function refuseReservedKey(container: string, value: unknown): void {
  if (holdsReservedKey(value)) throw new ReservedKeyWriteError(container)
}
