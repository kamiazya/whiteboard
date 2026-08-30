// The only thing that deletes from the blob mirror (ADR-0021 decision 6, far
// end: "retention must not delete behind").
//
// The mirror is append-only everywhere else, deliberately: file-GC deletes
// from the blob STORE and must never reach the backup, because reopening
// ADR-0020's hard-won GC fencing to teach it about backups would put the two
// most destructive passes in the system into one interaction.
//
// What may go is governed by which backups are still RETAINED, never by what
// the live data directory still references. A blob no document uses any more
// is still needed by every retained backup taken while it was in use, and
// collecting it on liveness grounds is what turns a backup that reports
// itself present into one that fails partway through a restore.

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getLogger } from '../log.js'
import { readBackupBlobManifest } from './backup-blob-mirror.js'
import { collectableFromBackup } from './backup-retention.js'

const log = getLogger('backup-mirror-retention')

/**
 * A directory the scheduler wrote. Same shape the scheduler's own retention
 * counts, and for the same reason: an operator's notes directory sitting in
 * the backup root is not a backup, and reading it as one that references
 * nothing would make this pass delete everything it protects.
 */
const BACKUP_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/

const STORES = [
  { dir: 'blobs', of: (refs: Awaited<ReturnType<typeof readBackupBlobManifest>>) => refs?.blobs },
  {
    dir: 'files',
    of: (refs: Awaited<ReturnType<typeof readBackupBlobManifest>>) =>
      refs ? new Set(Object.values(refs.files)) : undefined,
  },
] as const

/**
 * Delete from the mirror everything no retained backup references.
 *
 * Answers how many entries were removed. Runs after the scheduler has pruned
 * expired backup directories, so "retained" is simply "still on disk".
 *
 * **Refuses to collect anything if any backup cannot say what it needs.** A
 * directory with no readable manifest predates the mirror or is damaged, and
 * either way its references are unknown — narrowing the survivor set on the
 * strength of a backup that said nothing is how this pass would delete the
 * mirror out from under every backup beside it. Doing nothing costs disk;
 * getting it wrong costs the backups.
 */
export async function collectMirroredBlobs(backupRoot: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(backupRoot)
  } catch (err) {
    log.warning({ err }, 'could not list the backup root; collecting nothing from the mirror')
    return 0
  }

  const retained = entries.filter((name) => BACKUP_DIR_NAME.test(name))
  const manifests = await Promise.all(
    retained.map((name) => readBackupBlobManifest(join(backupRoot, name))),
  )
  const silent = retained.filter((_name, index) => manifests[index] === null)
  if (silent.length > 0) {
    log.warning(
      { backups: silent.length },
      'a retained backup does not say which blobs it needs; collecting nothing from the mirror',
    )
    return 0
  }

  let collected = 0
  for (const store of STORES) {
    const present = await listMirrored(backupRoot, store.dir)
    if (present.size === 0) continue
    const offered = manifests.map((refs, index) => ({
      id: retained[index] ?? '',
      refs: store.of(refs) ?? new Set<string>(),
    }))
    for (const digest of collectableFromBackup(present, offered)) {
      const path = join(backupRoot, store.dir, digest.slice(0, 2), digest.slice(2))
      try {
        await rm(path, { force: true })
        collected += 1
      } catch (err) {
        log.warning({ err }, 'could not remove an unreferenced entry from the mirror')
      }
    }
  }
  return collected
}

async function listMirrored(backupRoot: string, store: string): Promise<Set<string>> {
  const found = new Set<string>()
  let shards: string[]
  try {
    shards = await readdir(join(backupRoot, store))
  } catch {
    // No such store is an ordinary state — a deployment with no uploads, or
    // no saved versions.
    return found
  }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue
    let rest: string[]
    try {
      rest = await readdir(join(backupRoot, store, shard))
    } catch {
      continue
    }
    // A `.partial-*` left by an interrupted copy is not an entry; it fails
    // this test and is left where it is rather than being counted as
    // unreferenced content and deleted.
    for (const name of rest) if (/^[0-9a-f]{62}$/.test(name)) found.add(`${shard}${name}`)
  }
  return found
}
