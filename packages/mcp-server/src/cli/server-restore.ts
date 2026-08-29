import { lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { hasAncestorSymlink } from '../server/backup-restore.js'
import type { ServerModeRecordReadResult } from '../server/security/server-mode-record.js'
import { readServerModeRecord } from '../server/security/server-mode-record.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { restoreServerModeDataDir } from '../server/server-mode-backup-restore.js'
import { databaseIsInsideDataDir, dataDirHasDatabaseFile } from '../server/store/db/location.js'
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

  // The mirror of the backup guard, asked of the artifact for the same reason:
  // restore is also documented as a host-side command, so the environment here
  // may not be the deployment's. A backup directory holding no database cannot
  // put rows back, and succeeding would leave the operator starting a server
  // against blobs alone.
  //
  // The location record does NOT belong on this side, though it is the
  // obvious symmetry to reach for. Restore requires the target to be empty or
  // missing (`restoreDataDir`), so a target can never be holding a record to
  // read — a check for one is unreachable in production and passes its own
  // tests only because they mock the restore that would have rejected the
  // non-empty directory. The backup directory's copy of the record is no use
  // either: backup refuses to produce one unless it said "inside", so it is
  // `true` in every backup this code can create.
  if (!databaseIsInsideDataDir(targetDir, env) || !(await dataDirHasDatabaseFile(backupDir))) {
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
