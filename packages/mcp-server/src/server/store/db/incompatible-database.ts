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

/**
 * What a database or data-directory layout written before the pre-1.0 schema
 * reset is told. Nothing upgrades it, so the message carries the one way
 * across that keeps the documents: the earlier release's own export, and this
 * release's import on a fresh data directory. `subject` names what was found,
 * with its location, since the data directory is configurable.
 */
export function retiredStorageMessage(subject: string): string {
  return (
    `${subject} was written by an earlier release of whiteboard, and this build does not ` +
    'upgrade it: before 1.0 the daemon storage was reset to a single baseline, and an older ' +
    'database or data-directory layout is refused rather than migrated. This build has not ' +
    'changed it. To keep its documents, start the earlier release on this data directory and ' +
    'save each document from the web app (More actions → Export… → Save as Markdown for a ' +
    'note, Save as JSON Canvas for a canvas); then start this release on a fresh data ' +
    'directory (an empty WHITEBOARD_DATA_DIR, or this one moved aside) and bring the files in ' +
    'with New → Import file…. Versions, comments and uploaded images do not travel in those ' +
    'files. With nothing to keep, move the data directory aside and restart. See ' +
    'docs/contributing/mcp-debugging.md (Database Migration Errors).'
  )
}
