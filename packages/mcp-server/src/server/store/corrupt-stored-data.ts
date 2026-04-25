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

export function corruptStoredData(path: string, detail: string): CorruptStoredDataError {
  return new CorruptStoredDataError(`Stored data at "${path}" is corrupt: ${detail}`)
}
