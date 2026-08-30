import { resolve } from 'node:path'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import type { ServerBackupOutcome } from '../server/store/backup-pass.js'
import { performBackup } from '../server/store/backup-pass.js'
import type { ServerBackupArgs } from './server-backup-args.js'

export type { ServerBackupOutcome } from '../server/store/backup-pass.js'

export interface RunServerBackupOptions {
  args: ServerBackupArgs & { kind: 'ok' }
  env?: NodeJS.ProcessEnv
  doBackup?: (src: string, dest: string, opts: BackupRestoreOptions) => Promise<void>
  doSnapshot?: (dataDir: string, destPath: string) => Promise<void>
}

/**
 * `whiteboard server backup` — argument handling, and nothing else.
 *
 * The backup itself is `performBackup`, shared with the scheduled pass.
 * ADR-0021 decision 4 makes the schedule the mechanism and this command a
 * manual trigger of it, "rather than a second, differently-shaped
 * implementation" — so the only thing that belongs here is turning arguments
 * into the two directories the pass works on.
 */
export async function runServerBackup(
  options: RunServerBackupOptions,
): Promise<ServerBackupOutcome> {
  const { args, env = process.env, doBackup, doSnapshot } = options
  return performBackup({
    dataDir: resolve(args.dataDir ?? resolveDefaultDataDir(env)),
    outputDir: resolve(args.outputDir),
    env,
    ...(doBackup ? { doBackup } : {}),
    ...(doSnapshot ? { doSnapshot } : {}),
  })
}
