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
type FileCollectionStep =
  /** An upload old enough that no grace window still covers it. */
  | { readonly op: 'upload'; readonly fileId: string }
  | { readonly op: 'create'; readonly path: string; readonly draws: readonly string[] }
  /** Replaces what the document draws. */
  | { readonly op: 'draw'; readonly path: string; readonly draws: readonly string[] }
  /**
   * A proposal on the document adding one node per image, stored with every
   * change at `status` — what an agent's propose-mode edit leaves until a
   * person decides it.
   */
  | {
      readonly op: 'propose'
      readonly path: string
      readonly draws: readonly string[]
      readonly status: 'open' | 'dismissed'
    }
  | { readonly op: 'save-version'; readonly path: string }
  /** Into the trash, restorable. */
  | { readonly op: 'delete'; readonly path: string }
  /** Out of the trash for good, its versions with it. */
  | { readonly op: 'purge'; readonly path: string }

export type FileCollectionKeeper = 'daemon' | 'browser'

/**
 * A verdict one keeper is KNOWN to reach differently, recorded so the
 * difference is a stated gap with its reason rather than a step the scenario
 * quietly leaves out.
 */
interface KnownDivergence {
  readonly keeper: FileCollectionKeeper
  readonly fileId: string
  readonly reaches: 'collected'
  readonly why: string
}

export interface FileCollectionScenario {
  readonly steps: readonly FileCollectionStep[]
  /** Upload ids a collection pass must keep. */
  readonly kept: readonly string[]
  /** Upload ids it must drop. */
  readonly collected: readonly string[]
  readonly knownDivergences: readonly KnownDivergence[]
}

export const FILE_COLLECTION_CONFORMANCE: FileCollectionScenario = {
  steps: [
    { op: 'upload', fileId: 'img-live' },
    { op: 'upload', fileId: 'img-then' },
    { op: 'upload', fileId: 'img-trashed' },
    { op: 'upload', fileId: 'img-trashed-then' },
    { op: 'upload', fileId: 'img-purged' },
    { op: 'upload', fileId: 'img-proposed' },
    { op: 'upload', fileId: 'img-dismissed' },
    { op: 'upload', fileId: 'img-orphan' },
    { op: 'create', path: 'kept', draws: ['img-live'] },
    { op: 'propose', path: 'kept', draws: ['img-proposed'], status: 'open' },
    { op: 'propose', path: 'kept', draws: ['img-dismissed'], status: 'dismissed' },
    { op: 'create', path: 'versioned', draws: ['img-then'] },
    { op: 'save-version', path: 'versioned' },
    { op: 'draw', path: 'versioned', draws: [] },
    { op: 'create', path: 'trashed', draws: ['img-trashed'] },
    { op: 'delete', path: 'trashed' },
    { op: 'create', path: 'trashed-versioned', draws: ['img-trashed-then'] },
    { op: 'save-version', path: 'trashed-versioned' },
    { op: 'draw', path: 'trashed-versioned', draws: [] },
    { op: 'delete', path: 'trashed-versioned' },
    { op: 'create', path: 'purged', draws: ['img-purged'] },
    { op: 'delete', path: 'purged' },
    { op: 'purge', path: 'purged' },
  ],
  kept: ['img-live', 'img-proposed', 'img-then', 'img-trashed', 'img-trashed-then'],
  collected: ['img-dismissed', 'img-orphan', 'img-purged'],
  knownDivergences: [
    {
      keeper: 'daemon',
      fileId: 'img-trashed-then',
      reaches: 'collected',
      why:
        "the daemon's version store lists a history by PATH, and a trashed document has none, " +
        "so its saved versions are not walked; the browser's rows are keyed by document id",
    },
  ],
}

/** What `keeper` is expected to keep and drop, its known divergences applied. */
export function conformanceVerdictFor(keeper: FileCollectionKeeper): {
  readonly kept: readonly string[]
  readonly collected: readonly string[]
} {
  const { kept, collected, knownDivergences } = FILE_COLLECTION_CONFORMANCE
  const moved = new Set(
    knownDivergences.filter((gap) => gap.keeper === keeper).map((gap) => gap.fileId),
  )
  return {
    kept: kept.filter((fileId) => !moved.has(fileId)),
    collected: [...collected, ...kept.filter((fileId) => moved.has(fileId))],
  }
}
