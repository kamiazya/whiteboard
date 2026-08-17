export class CorruptStoredDataError extends Error {
  readonly code = 'corrupt_stored_data'

  constructor(message: string) {
    super(message)
    this.name = 'CorruptStoredDataError'
  }
}

export function isCorruptStoredDataError(error: unknown): error is CorruptStoredDataError {
  return error instanceof CorruptStoredDataError
}

export function corruptStoredDataBody(
  error: unknown,
): { error: 'corrupt_stored_data'; message: string } | null {
  if (!isCorruptStoredDataError(error)) return null
  return { error: 'corrupt_stored_data', message: error.message }
}

export function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

// `locationKind` defaults to 'file': most callers (thumbnails, uploaded
// files, blob-store envelopes) pass a real FS path an operator can go
// inspect. 'identity' is for callers passing a label that is stable and
// traceable but is NOT where the corrupt bytes actually live (e.g.
// document-store.ts's canvas snapshots, which moved into Libsql rows but
// keep their old blob path as an id) — the wording must not send an
// operator looking for a file that no longer exists.
export function corruptStoredData(
  path: string,
  detail: string,
  options?: { locationKind?: 'file' | 'identity' },
): CorruptStoredDataError {
  const phrase =
    options?.locationKind === 'identity'
      ? `Stored canvas data identified by "${path}" is corrupt`
      : `Stored data at "${path}" is corrupt`
  return new CorruptStoredDataError(`${phrase}: ${detail}`)
}
