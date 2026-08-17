import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Migration } from 'kysely'
import { getDataDir } from '../../../config.js'
import { getLogger } from '../../../log.js'

// A document's blob has always lived at
// `{dataDir}/blobs/{workspaceId}/document/{documentId}.loro`. The `canvas`
// segment names the CONTAINER, which ADR-0009 calls a Document — the same
// violation 0009 and 0010 removed from the database. It survived those two
// because it is a stored LAYOUT rather than a column: correcting it means
// moving bytes on disk, which is this migration rather than a rename.
//
// Touching the filesystem from a migration is not new here: 0008 moves a
// document's blob when it re-keys a nanoid to a ULID. What is different is
// that this walk is per WORKSPACE, so the loop below is over the blobs root
// rather than over a table.
//
// Only the one segment moves. A workspace directory also holds `files/`
// (uploaded attachments, swept by file-gc-sweeper), and renaming the
// workspace directory — or moving anything but this child — would take those
// with it.
const OLD_SEGMENT = 'canvas'
const NEW_SEGMENT = 'document'

const log = getLogger('migration-0011')

/**
 * Moves `blobs/<workspaceId>/<from>` to `blobs/<workspaceId>/<to>` for every
 * workspace that has one.
 *
 * Total by design, because it runs at BOOT: a data dir with no blobs root
 * (a fresh install, which migrates before the store writes anything), a
 * workspace with no blobs, and a workspace whose directory holds only
 * `files/` all have nothing to move and must not fail startup over it.
 */
async function moveSegment(from: string, to: string): Promise<void> {
  const blobsRoot = join(getDataDir(), 'blobs')

  let workspaces: string[]
  try {
    workspaces = (await readdir(blobsRoot, { withFileTypes: true, encoding: 'utf8' }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  for (const workspaceId of workspaces) {
    try {
      await rename(join(blobsRoot, workspaceId, from), join(blobsRoot, workspaceId, to))
    } catch (err) {
      // ENOENT: this workspace never stored a document. ENOTEMPTY/EEXIST: a
      // directory already sits at the destination, which means a previous run
      // was interrupted after moving this workspace — the log row had not been
      // written, so the migrator is replaying. Either way the workspace is
      // already in the state this migration wants, and failing would leave the
      // daemon unable to boot over work that is already done.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        log.warning({ workspaceId, from, to }, 'blob segment already moved; leaving it alone')
        continue
      }
      throw err
    }
  }
}

export const migration: Migration = {
  async up(): Promise<void> {
    await moveSegment(OLD_SEGMENT, NEW_SEGMENT)
  },

  async down(): Promise<void> {
    await moveSegment(NEW_SEGMENT, OLD_SEGMENT)
  },
}
