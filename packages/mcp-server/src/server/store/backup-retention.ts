/**
 * The two boundaries [ADR-0021](../../../../../docs/contributing/adr/0021-durability-boundary.md)
 * decision 6 places around a backup's validity, as the predicates that decide
 * them.
 *
 * They read like two rules and are one. A snapshot of the rows references
 * blobs; it can be restored exactly while every blob it references is present
 * in the blob backup. So the whole guarantee is a containment —
 * `snapshot.refs ⊆ backup` — and the two rules are the two directions that
 * containment can be broken:
 *
 * - Offering a snapshot **too early**, before the mirror has copied the blobs
 *   it references. `sealableSnapshots` is that boundary.
 * - Deleting from the backup **too soon**, while a snapshot still on offer
 *   references what is deleted. `collectableFromBackup` is that one.
 *
 * Both failures are silent, and neither is visible at the moment it happens:
 * the first produces a backup that never could be restored, the second one
 * that could be restored yesterday and cannot today. That is why they are
 * predicates with a property over them rather than conditions inline at two
 * call sites.
 *
 * Blob liveness in the *store* is a different question, answered by file-GC,
 * and deliberately not answered here — ADR-0021 decision 5 keeps the blob
 * store and the blob backup apart precisely so garbage collection's fencing
 * (ADR-0020) is not reopened to know about backups.
 */

/** A row snapshot, as the two boundaries need to see it. */
export interface BackupSnapshot {
  id: string
  /** The blobs this snapshot's rows reference. */
  refs: ReadonlySet<string>
}

/**
 * The snapshots the mirror has now caught up past — those safe to offer for
 * restore.
 *
 * A snapshot taken at T may reference a blob written just before T that the
 * mirror has not copied yet. Offering it then produces a backup that cannot
 * be restored, so a snapshot waits here until its own references are all
 * present. Nothing about wall-clock time enters into it: "the mirror has
 * passed T" is observable only as "the blobs are there", and asking the
 * question that way removes any dependence on two clocks agreeing.
 */
export function sealableSnapshots(
  pending: readonly BackupSnapshot[],
  backup: ReadonlySet<string>,
): BackupSnapshot[] {
  return pending.filter((snapshot) => {
    for (const ref of snapshot.refs) {
      if (!backup.has(ref)) return false
    }
    return true
  })
}

/**
 * What the retention pass may delete from the blob backup.
 *
 * Governed by which snapshots are still **on offer**, never by what the live
 * document still references. A blob the current document has replaced is
 * still referenced by every offered snapshot taken while it was in use, and
 * deleting it on liveness grounds is what turns a restorable backup into one
 * that reports itself present and fails partway through a restore.
 *
 * This is the only thing that deletes from the blob backup.
 */
export function collectableFromBackup(
  backup: ReadonlySet<string>,
  offered: readonly BackupSnapshot[],
): string[] {
  const stillReferenced = new Set<string>()
  for (const snapshot of offered) {
    for (const ref of snapshot.refs) stillReferenced.add(ref)
  }
  return [...backup].filter((blobId) => !stillReferenced.has(blobId))
}

/**
 * Whether an offered snapshot could actually be restored right now.
 *
 * The invariant the two boundaries exist to hold, written once so it can be
 * asserted rather than argued. Cheap enough to call on a restore attempt,
 * which is the moment an operator most wants it checked.
 */
export function snapshotIsRestorable(
  snapshot: BackupSnapshot,
  backup: ReadonlySet<string>,
): boolean {
  for (const ref of snapshot.refs) {
    if (!backup.has(ref)) return false
  }
  return true
}
