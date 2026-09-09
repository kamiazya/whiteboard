import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely, Migration } from 'kysely'
import { getDataDir } from '../../../config.js'
import { getLogger } from '../../../log.js'

const log = getLogger('migration-0024')

// The history row's miniature is retired. A saved point is looked at by
// OPENING it, which draws the document itself in the reader's own theme;
// the stored PNG was rasterised at save time under the light palette and
// could never be anything else, so a dark reader saw a white card either way.
// It also only ever appeared on rows a person bookmarked, never on the
// automatic checkpoints between them, so the list it decorated was mostly
// undecorated anyway.
//
// Both halves go together on purpose. Dropping the column alone would leave
// `blobs/<workspaceId>/versions/*.png` on disk with nothing left in the
// schema that could ever name a file there — the shape an operator finds
// later and cannot explain, and one no sweeper would collect (file-GC walks
// uploaded images).
//
// The path segments are FROZEN literals rather than an import of
// `version-store.ts`'s join, which this migration deletes: a recorded
// migration must not depend on living code that can change out from under it
// (0011's rule, and its worked example).
const BLOBS_DIR = 'blobs'
const VERSIONS_SEGMENT = 'versions'

/** Every `blobs/<workspaceId>/versions` tree, whatever the deployment holds. */
async function removeVersionPictureTrees(): Promise<number> {
  const blobs = join(getDataDir(), BLOBS_DIR)
  let workspaces: string[]
  try {
    workspaces = await readdir(blobs)
  } catch {
    // No blobs at all is the normal state of a deployment that never saved a
    // bookmark, and a migration that throws on it is a daemon that will not
    // start.
    return 0
  }
  let removed = 0
  for (const workspaceId of workspaces) {
    const tree = join(blobs, workspaceId, VERSIONS_SEGMENT)
    try {
      const files = await readdir(tree)
      await rm(tree, { recursive: true, force: true })
      removed += files.length
    } catch {
      // A workspace with no pictures, or an entry that is not a directory.
      // Neither is a reason to fail the upgrade.
    }
  }
  return removed
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const removed = await removeVersionPictureTrees()
    if (removed > 0) {
      log.warning(
        { count: removed },
        `${removed} version thumbnails removed — the history row no longer draws one`,
      )
    }
    await db.schema.alterTable('versions').dropColumn('hasThumbnail').execute()
  },
  async down(): Promise<void> {
    // The column could come back; the pictures could not, and a column that
    // claims a picture for every row while the files are gone is worse than
    // no column. Pre-1.0 disposable-DB policy, the same call 0017 and 0023
    // made for the same reason.
    throw new Error('0024-drop-version-thumbnails cannot be rolled back')
  },
}
