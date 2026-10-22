import {
  holdsReservedKey,
  RESERVED_MAP_KEY,
  type SyncWriteRefusalCode,
} from '@kamiazya/whiteboard-model'

/**
 * A value write refused because the value holds a key named `__proto__` —
 * the shape the sync judge refuses as `reserved_map_key`, held at every
 * writer so no write path can store what a sync update may not carry.
 * Thrown before the first op, so nothing of the write was kept.
 */
export class ReservedKeyWriteError extends Error {
  readonly code = 'reserved_map_key' satisfies SyncWriteRefusalCode

  constructor(readonly container: string) {
    super(
      `This write holds a key named "${RESERVED_MAP_KEY}" (in ${container}), which no document may hold, so nothing of it was kept`,
    )
    this.name = 'ReservedKeyWriteError'
  }
}

/** Throws `ReservedKeyWriteError` when `value`, bound for `container`, holds the reserved key. */
export function refuseReservedKey(container: string, value: unknown): void {
  if (holdsReservedKey(value)) throw new ReservedKeyWriteError(container)
}
