import { lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { hasAncestorSymlink } from '../server/backup-restore.js'
import type { ServerModeRecordReadResult } from '../server/security/server-mode-record.js'
import { readServerModeRecord } from '../server/security/server-mode-record.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { backupServerModeDataDir } from '../server/server-mode-backup-restore.js'
import type { ServerBackupArgs } from './server-backup-args.js'

export interface RunServerBackupOptions {
  args: ServerBackupArgs & { kind: 'ok' }
  env?: NodeJS.ProcessEnv
  isPidAlive?: (pid: number) => boolean
  doReadRecord?: (dataDir: string) => ServerModeRecordReadResult
  doBackup?: (src: string, dest: string, opts: BackupRestoreOptions) => Promise<void>
}

export type ServerBackupOutcome =
  | { kind: 'ok'; result: ServerBackupResult }
  | { kind: 'running-server' }
  | { kind: 'invalid-output-path' }
  | { kind: 'error'; message: string }

interface ServerBackupResult {
  schemaVersion: 1
  ok: true
  operation: 'backup'
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
  } = options

  const dataDir = resolve(args.dataDir ?? resolveDefaultDataDir(env))
  const outputDir = resolve(args.outputDir)

  // Refuse to backup a live server's data directory.
  const record = doReadRecord(dataDir)
  if (record.kind === 'ok' && isPidAlive(record.record.pid)) {
    return { kind: 'running-server' }
  }

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

  try {
    await doBackup(dataDir, outputDir, {
      // dirname is non-tautological: the helper's assertWithinAllowed verifies
      // outputDir against its parent, not against itself.
      allowedRoots: [dataDir, dirname(outputDir)],
    })
  } catch {
    return { kind: 'error', message: 'backup failed' }
  }

  return {
    kind: 'ok',
    result: { schemaVersion: 1, ok: true, operation: 'backup' },
  }
}
