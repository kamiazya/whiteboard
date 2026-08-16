/**
 * Discriminates every way a chunk set can fail to reconstruct a snapshot.
 * Named and exhaustive so callers can branch on `code` instead of parsing
 * an error message, and so a corruption test can assert the exact failure
 * mode rather than a bare `toThrow()`.
 */
export type SnapshotReassemblyErrorCode =
  | 'MISSING_CHUNK'
  | 'EXTRA_CHUNK'
  | 'DUPLICATE_INDEX'
  | 'WRONG_OF'
  | 'WRONG_BYTE_LENGTH'
  | 'WRONG_TOTAL_LENGTH'
  | 'EMPTY_CHUNK_LIST'
  | 'INVALID_MANIFEST'

export class SnapshotReassemblyError extends Error {
  readonly code: SnapshotReassemblyErrorCode

  constructor(code: SnapshotReassemblyErrorCode, message: string) {
    super(message)
    this.name = 'SnapshotReassemblyError'
    this.code = code
  }
}
