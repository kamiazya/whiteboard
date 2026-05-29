import { unlink } from 'node:fs/promises'
import { BackupError, backupDataDir, restoreDataDir } from './backup-restore.js'
import type { BackupRestoreOptions } from './backup-restore.js'
import { getServerModeRecordPath } from './security/server-mode-record.js'

export { BackupError }
export type { BackupRestoreOptions }

// Copy srcDataDir into backupDir. server-mode.json is included so the record
// survives in the archive, but callers must use restoreServerModeDataDir (not
// restoreDataDir directly) to ensure the stale identity is neutralized on restore.
export async function backupServerModeDataDir(
  srcDataDir: string,
  backupDir: string,
  options: BackupRestoreOptions,
): Promise<void> {
  await backupDataDir(srcDataDir, backupDir, options)
}

// Restore backupDir into targetDataDir and remove any server-mode.json from
// the restored tree.
//
// The source server's record (PID, port, startedAt) must not be inherited by
// a fresh deployment. After this call the target holds the DB + blobs without
// the old identity; a fresh `whiteboard server run` will write a new record.
export async function restoreServerModeDataDir(
  backupDir: string,
  targetDataDir: string,
  options: BackupRestoreOptions,
): Promise<void> {
  await restoreDataDir(backupDir, targetDataDir, options)
  const recordPath = getServerModeRecordPath(targetDataDir)
  await unlink(recordPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  })
}
