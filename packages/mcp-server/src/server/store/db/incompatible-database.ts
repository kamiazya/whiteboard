// Typed error for a database whose recorded migration history is incompatible
// with the migrations the current build ships (e.g. a DB created by a newer
// release, opened by an older build). kysely surfaces this as a cryptic
// "corrupted migrations" error; runMigrations re-frames it as this typed,
// actionable error so the startup layer can show recovery guidance instead.
//
// Mirrors the CorruptStoredDataError pattern in ../corrupt-stored-data.ts
// (typed class + isXxx guard) for consistency.

export class IncompatibleDatabaseError extends Error {
  readonly code = 'incompatible_database'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'IncompatibleDatabaseError'
  }
}

export function isIncompatibleDatabaseError(error: unknown): error is IncompatibleDatabaseError {
  return error instanceof IncompatibleDatabaseError
}
