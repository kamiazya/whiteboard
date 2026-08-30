import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { hasAncestorSymlink } from '../backup-restore.js'
import { getLogger } from '../log.js'
import type { BackupRestoreOptions } from '../server-mode-backup-restore.js'
import { backupServerModeDataDir } from '../server-mode-backup-restore.js'
import { mirrorBlobsIntoBackup } from './backup-blob-mirror.js'
import { withBackupMarker } from './backup-in-progress.js'
import { DB_FILENAME, databaseIsInsideDataDir, dataDirHasDatabaseFile } from './db/location.js'
import { readDatabaseLocationRecord } from './db/location-record.js'
import { snapshotDatabaseInto } from './db/snapshot.js'

const log = getLogger('backup-pass')

export type ServerBackupOutcome =
  | { kind: 'ok'; result: ServerBackupResult }
  | { kind: 'missing-database' }
  | { kind: 'invalid-output-path' }
  | { kind: 'error'; message: string }

/**
 * What one store can say about a backup that has just been taken.
 *
 * `hosted-elsewhere` is a real answer rather than a failure (ADR-0021
 * decision 2). When the rows live in a libSQL server, that server's operator
 * already has point-in-time recovery, replicas and a retention policy;
 * reimplementing those would be worse than what it duplicates and would have
 * to be maintained against every provider. Saying so plainly is what stops
 * the operator trusting a copy that cannot restore them.
 */
const storeDurabilitySchema = z.union([
  z.object({ captured: z.literal(true) }),
  z.object({ captured: z.literal(false), reason: z.literal('hosted-elsewhere') }),
])

/**
 * The shape `whiteboard server backup --json` prints, declared once.
 *
 * A schema rather than an interface because this result now crosses a process
 * boundary: the scheduled pass runs the CLI as a child and reads this off its
 * stdout, so something has to check that what came back is what was expected
 * rather than trusting a `JSON.parse`. The type is inferred from the schema so
 * the two cannot drift.
 */
export const serverBackupResultSchema = z.object({
  schemaVersion: z.literal(2),
  ok: z.literal(true),
  operation: z.literal('backup'),
  /**
   * Per store, because one boolean cannot answer this once a deployment can
   * keep its stores in different places. The previous shape reported
   * `ok: true` for a directory copy and had no way to say that the rows were
   * somewhere else — which is exactly how a backup of blobs alone was once
   * reported as a success.
   *
   * `ok` remains, and remains true here: the operation did what it is
   * responsible for. What it no longer claims is COMPLETENESS, which is what
   * `stores` is for.
   */
  stores: z.object({
    database: storeDurabilitySchema,
    blobs: storeDurabilitySchema,
  }),
})

type ServerBackupResult = z.infer<typeof serverBackupResultSchema>

export interface BackupPassOptions {
  dataDir: string
  outputDir: string
  /**
   * Where the blob mirror lives (ADR-0021 decision 5). Defaults to
   * `outputDir`, which makes a one-off `whiteboard server backup` a
   * self-contained directory an operator can carry — the affordance a shared
   * mirror would otherwise take away. The SCHEDULE passes the backup root, so
   * its retained backups share one mirror and stop costing a full copy each.
   */
  mirrorRoot?: string
  env?: NodeJS.ProcessEnv
  doBackup?: (src: string, dest: string, opts: BackupRestoreOptions) => Promise<void>
  doSnapshot?: (dataDir: string, destPath: string) => Promise<void>
  doMirror?: typeof mirrorBlobsIntoBackup
}

/**
 * One backup, from an already-resolved pair of directories.
 *
 * Shared rather than duplicated, because ADR-0021 decision 4 makes the
 * scheduled pass the mechanism and `whiteboard server backup` a manual
 * trigger of that same pass — "rather than a second, differently-shaped
 * implementation of it". Everything above this in the CLI is argument
 * handling; everything here is the backup.
 */
export async function performBackup(options: BackupPassOptions): Promise<ServerBackupOutcome> {
  const {
    dataDir,
    outputDir,
    mirrorRoot = options.outputDir,
    env = process.env,
    doBackup = backupServerModeDataDir,
    doSnapshot = snapshotDatabaseInto,
    doMirror = mirrorBlobsIntoBackup,
  } = options

  // A running server is no longer a refusal (ADR-0021 decision 3). "A backup
  // requiring downtime is one an operator takes rarely or never, and the
  // interval between backups is the data they lose."
  //
  // Two things had to be true first, and both are. The rows are captured
  // through the database (`VACUUM INTO`) rather than by reading its bytes out
  // from under a writer, and every write into the data directory now lands
  // atomically, so a copy cannot pick up a half-written blob or upload. The
  // third — that nothing DELETES while the copy runs — is the marker below.
  //
  // Refuse when the rows are not in the directory being copied. This command
  // copies a directory, so a database configured to live anywhere else is
  // simply absent from the result — and reporting success over blobs alone
  // hands the operator a backup they will trust and cannot restore from.
  // Reject if the output path itself is a symlink or a plain file.
  try {
    const st = await lstat(outputDir)
    if (st.isSymbolicLink() || st.isFile()) {
      return { kind: 'invalid-output-path' }
    }
    // Existing directory (empty or not): let helper enforce the non-empty check.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'error', message: 'backup failed' }
    }
    // Missing output dir: helper creates it via cp().
  }

  // Reject if any ancestor path component is a symlink. An ancestor symlink
  // (e.g. <safe>/link → /outside) would redirect the backup to a location
  // outside the operator's intended storage zone, so fail-closed here instead
  // of following the link.
  try {
    if (await hasAncestorSymlink(outputDir)) {
      return { kind: 'invalid-output-path' }
    }
  } catch {
    return { kind: 'error', message: 'backup failed' }
  }

  // Apply the same guard to the read-side path so a symlinked dataDir cannot
  // be used to exfiltrate data outside the allowed zone.
  try {
    if (await hasAncestorSymlink(dataDir)) {
      return { kind: 'error', message: 'backup failed' }
    }
  } catch {
    return { kind: 'error', message: 'backup failed' }
  }

  // Three sources, because each alone is answerable from the wrong place.
  //
  // WHERE the rows live is the recorded answer when there is one: it was
  // written by the process that actually opened the database, so it is the
  // only source that survives being asked from a host shell the deployment's
  // env-file never reached, and the only one that can tell a live database
  // file from a fossil left behind by a move to libSQL. Absent — an install
  // predating the record, or one that has never started — the question falls
  // back to the environment, which is what it had before and no worse.
  //
  // WHETHER they are here is always the directory's to answer. The record
  // says where a deployment keeps its rows, never that the file is still
  // sitting there, so the artifact check stays in force underneath it.
  const recorded = await readDatabaseLocationRecord(dataDir)
  const configuredInside = recorded?.inDataDir ?? databaseIsInsideDataDir(dataDir, env)
  const databaseFilePresent = await dataDirHasDatabaseFile(dataDir)

  // The two answers together classify the deployment, and only one of the
  // four combinations is a refusal.
  //
  // Rows here and present, or rows elsewhere (with or without a fossil left
  // behind), are all deployments this command can serve — it simply captures
  // a different set of stores. But "the rows belong in this directory" and
  // "this directory has no rows" cannot both hold for a working deployment,
  // so that pair is a broken data directory rather than a partial backup, and
  // copying it would produce something restore could not use.
  if (configuredInside && !databaseFilePresent) {
    return { kind: 'missing-database' }
  }

  // Held across BOTH steps, because a backup is a snapshot plus a copy and
  // those are two moments. A file-GC pass unlinking between them removes a
  // file the snapshot still references, and the backup restores to a document
  // pointing at nothing — silently, since every step reported success. That
  // is ADR-0021 decision 6's far end in the shape this system has today.
  return withBackupMarker(dataDir, async () => {
    try {
      await doBackup(dataDir, outputDir, {
        // dirname is non-tautological: the helper's assertWithinAllowed verifies
        // outputDir against its parent, not against itself.
        allowedRoots: [dataDir, dirname(outputDir)],
        // The database never travels as FILES, whoever owns it.
        //
        // When it is ours the snapshot below carries it, and carries it better:
        // a copy would have to take `whiteboard.db`, `-wal` and `-shm` as one
        // artifact, while a snapshot is a single file with the WAL already
        // folded in. When it is not ours, any file of that name is a fossil
        // from before the move, and copying it would put pre-migration rows in
        // the backup for restore to put back as current.
        excludeDatabaseFile: true,
        // The blobs travel through the mirror below, not as a tree copy.
        // Copying them here as well would put back exactly the per-backup
        // duplication the mirror exists to remove.
        excludeBlobs: true,
      })
    } catch {
      return { kind: 'error', message: 'backup failed' }
    }

    // Ordered after the copy because the copy requires an empty destination,
    // and `VACUUM INTO` refuses to overwrite. Neither can go first twice.
    if (configuredInside) {
      try {
        await doSnapshot(dataDir, join(outputDir, DB_FILENAME))
      } catch {
        // A snapshot that failed must fail the BACKUP. Reporting success over a
        // directory holding blobs and no rows is precisely the defect this area
        // exists to remove, and it would arrive by simply not checking.
        return { kind: 'error', message: 'backup failed' }
      }
    }

    // After the copy: `backupDataDir` requires an empty destination, and for a
    // self-contained backup the mirror writes inside that same directory.
    try {
      await doMirror(dataDir, mirrorRoot, {
        manifestInto: outputDir,
        mirror: mirrorRoot === outputDir ? 'self' : 'parent',
      })
    } catch (err) {
      // A backup whose blobs did not travel is not a backup, however complete
      // the rows are — restoring it gives documents that point at nothing.
      log.error({ err }, 'could not mirror the blobs; the backup is not usable')
      return { kind: 'error', message: 'backup failed' }
    }

    return {
      kind: 'ok',
      result: {
        schemaVersion: 2,
        ok: true,
        operation: 'backup',
        stores: {
          database: configuredInside
            ? { captured: true }
            : { captured: false, reason: 'hosted-elsewhere' },
          blobs: { captured: true },
        },
      },
    }
  })
}
