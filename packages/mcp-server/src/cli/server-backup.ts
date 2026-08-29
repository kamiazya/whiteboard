import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { hasAncestorSymlink } from '../server/backup-restore.js'
import type { ServerModeRecordReadResult } from '../server/security/server-mode-record.js'
import { readServerModeRecord } from '../server/security/server-mode-record.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { backupServerModeDataDir } from '../server/server-mode-backup-restore.js'
import {
  DB_FILENAME,
  databaseIsInsideDataDir,
  dataDirHasDatabaseFile,
} from '../server/store/db/location.js'
import { readDatabaseLocationRecord } from '../server/store/db/location-record.js'
import { snapshotDatabaseInto } from '../server/store/db/snapshot.js'
import type { ServerBackupArgs } from './server-backup-args.js'

export interface RunServerBackupOptions {
  args: ServerBackupArgs & { kind: 'ok' }
  env?: NodeJS.ProcessEnv
  isPidAlive?: (pid: number) => boolean
  doReadRecord?: (dataDir: string) => ServerModeRecordReadResult
  doBackup?: (src: string, dest: string, opts: BackupRestoreOptions) => Promise<void>
  doSnapshot?: (dataDir: string, destPath: string) => Promise<void>
}

export type ServerBackupOutcome =
  | { kind: 'ok'; result: ServerBackupResult }
  | { kind: 'running-server' }
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
type StoreDurability = { captured: true } | { captured: false; reason: 'hosted-elsewhere' }

interface ServerBackupResult {
  schemaVersion: 2
  ok: true
  operation: 'backup'
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
  stores: {
    database: StoreDurability
    blobs: StoreDurability
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function runServerBackup(
  options: RunServerBackupOptions,
): Promise<ServerBackupOutcome> {
  const {
    args,
    env = process.env,
    isPidAlive = defaultIsPidAlive,
    doReadRecord = readServerModeRecord,
    doBackup = backupServerModeDataDir,
    doSnapshot = snapshotDatabaseInto,
  } = options

  const dataDir = resolve(args.dataDir ?? resolveDefaultDataDir(env))
  const outputDir = resolve(args.outputDir)

  // Refuse to backup a live server's data directory.
  const record = doReadRecord(dataDir)
  if (record.kind === 'ok' && isPidAlive(record.record.pid)) {
    return { kind: 'running-server' }
  }

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
}
