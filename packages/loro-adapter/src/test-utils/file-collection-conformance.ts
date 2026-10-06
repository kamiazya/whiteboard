/**
 * One scenario every keeper's file collection runs through its OWN
 * operations — its own create, version save, delete and trash purge — and
 * must reach the same verdict on.
 *
 * `scanFileReferences` is shared, but what reaches it is not: each keeper
 * stores trash bytes, version rows and uploads its own way, and a reader that
 * drops one of them makes the shared walk judge less than the record holds.
 * Declared as data so the two suites cannot drift into testing different
 * stories; each interprets every step, so a step one keeper cannot take
 * fails its suite instead of being skipped.
 */
export type FileCollectionStep =
  /** An upload old enough that no grace window still covers it. */
  | { readonly op: 'upload'; readonly fileId: string }
  | { readonly op: 'create'; readonly path: string; readonly draws: readonly string[] }
  /** Replaces what the document draws. */
  | { readonly op: 'draw'; readonly path: string; readonly draws: readonly string[] }
  | { readonly op: 'save-version'; readonly path: string }
  /** Into the trash, restorable. */
  | { readonly op: 'delete'; readonly path: string }
  /** Out of the trash for good, its versions with it. */
  | { readonly op: 'purge'; readonly path: string }

export interface FileCollectionScenario {
  readonly steps: readonly FileCollectionStep[]
  /** Upload ids a collection pass must keep. */
  readonly kept: readonly string[]
  /** Upload ids it must drop. */
  readonly collected: readonly string[]
}

export const FILE_COLLECTION_CONFORMANCE: FileCollectionScenario = {
  steps: [
    { op: 'upload', fileId: 'img-live' },
    { op: 'upload', fileId: 'img-then' },
    { op: 'upload', fileId: 'img-trashed' },
    { op: 'upload', fileId: 'img-purged' },
    { op: 'upload', fileId: 'img-orphan' },
    { op: 'create', path: 'kept', draws: ['img-live'] },
    { op: 'create', path: 'versioned', draws: ['img-then'] },
    { op: 'save-version', path: 'versioned' },
    { op: 'draw', path: 'versioned', draws: [] },
    { op: 'create', path: 'trashed', draws: ['img-trashed'] },
    { op: 'delete', path: 'trashed' },
    { op: 'create', path: 'purged', draws: ['img-purged'] },
    { op: 'delete', path: 'purged' },
    { op: 'purge', path: 'purged' },
  ],
  kept: ['img-live', 'img-then', 'img-trashed'],
  collected: ['img-orphan', 'img-purged'],
}
