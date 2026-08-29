import { lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { hasAncestorSymlink } from '../server/backup-restore.js'
import type { ServerModeRecordReadResult } from '../server/security/server-mode-record.js'
import { readServerModeRecord } from '../server/security/server-mode-record.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { restoreServerModeDataDir } from '../server/server-mode-backup-restore.js'
import { databaseIsInsideDataDir, dataDirHasDatabaseFile } from '../server/store/db/location.js'
import { readDatabaseLocationRecord } from '../server/store/db/location-record.js'
import type { ServerRestoreArgs } from './server-restore-args.js'

export interface RunServerRestoreOptions {
  args: ServerRestoreArgs & { kind: 'ok' }
  env?: NodeJS.ProcessEnv
  isPidAlive?: (pid: number) => boolean
  doReadRecord?: (dataDir: string) => ServerModeRecordReadResult
  doRestore?: (backup: string, target: string, opts: BackupRestoreOptions) => Promise<void>
}

export type ServerRestoreOutcome =
  | { kind: 'ok'; result: ServerRestoreResult }
  | { kind: 'running-target' }
  | { kind: 'external-database' }
  | { kind: 'invalid-target-path' }
  | { kind: 'error'; message: string }

interface ServerRestoreResult {
  schemaVersion: 1
  ok: true
  operation: 'restore'
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function runServerRestore(
  options: RunServerRestoreOptions,
): Promise<ServerRestoreOutcome> {
  const {
    args,
    env = process.env,
    isPidAlive = defaultIsPidAlive,
    doReadRecord = readServerModeRecord,
    doRestore = restoreServerModeDataDir,
  } = options

  const backupDir = resolve(args.backupDir)
  const targetDir = resolve(args.targetDir)

  // Refuse to restore into a live server's data directory.
  const record = doReadRecord(targetDir)
  if (record.kind === 'ok' && isPidAlive(record.record.pid)) {
    return { kind: 'running-target' }
  }

  // Reject if the target path itself is a symlink or a plain file.
  try {
    const st = await lstat(targetDir)
    if (st.isSymbolicLink() || st.isFile()) {
      return { kind: 'invalid-target-path' }
    }
    // Existing directory: let helper enforce the non-empty check.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'error', message: 'restore failed' }
    }
    // Missing target: helper creates it via cp().
  }

  // Reject if any ancestor path component is a symlink, to prevent redirecting
  // the restore to a location outside the operator's intended storage zone.
  try {
    if (await hasAncestorSymlink(targetDir)) {
      return { kind: 'invalid-target-path' }
    }
  } catch {
    return { kind: 'error', message: 'restore failed' }
  }

  // Apply the same guard to the read-side path so a symlinked backupDir cannot
  // be used to read from outside the allowed zone.
  try {
    if (await hasAncestorSymlink(backupDir)) {
      return { kind: 'error', message: 'restore failed' }
    }
  } catch {
    return { kind: 'error', message: 'restore failed' }
  }

  // One symmetry: the backup must supply exactly the rows the target needs.
  //
  // The BACKUP's own copy of `storage.json` says whether it was ever meant to
  // hold rows. Since backup stopped refusing outright for a deployment whose
  // rows live in libSQL, a backup can legitimately contain none — the fossil
  // is deliberately left out so a restore cannot put pre-migration rows back
  // as current. Without the record, that legitimate backup is
  // indistinguishable from a truncated one.
  //
  // The record wins over the file, for the same reason it does on the backup
  // side: a `whiteboard.db` sitting in a backup whose record says the rows
  // were elsewhere is a fossil, and it supplies nothing.
  //
  // The TARGET's need is the environment's to answer, and only the
  // environment's — `restoreDataDir` requires an empty or missing target, so
  // a target never carries a record of its own to read.
  const backupRecord = await readDatabaseLocationRecord(backupDir)
  // A backup predating the record is assumed to hold rows: that was the only
  // kind this command could produce, so its file presence is the whole answer.
  const backupClaimsRows = backupRecord?.inDataDir ?? true
  const backupSuppliesRows = backupClaimsRows && (await dataDirHasDatabaseFile(backupDir))
  const targetNeedsRows = databaseIsInsideDataDir(targetDir, env)

  // Unequal in either direction is a restore across a configuration change,
  // which ADR-0021 explicitly does not answer. Refusing beats half-performing
  // it: rows-less into a target expecting rows leaves a server pointed at
  // nothing, and rows into a target reading libSQL writes a file nobody opens.
  if (backupSuppliesRows !== targetNeedsRows) {
    return { kind: 'external-database' }
  }

  try {
    await doRestore(backupDir, targetDir, {
      allowedRoots: [dirname(backupDir), dirname(targetDir)],
    })
  } catch {
    return { kind: 'error', message: 'restore failed' }
  }

  return {
    kind: 'ok',
    result: { schemaVersion: 1, ok: true, operation: 'restore' },
  }
}
