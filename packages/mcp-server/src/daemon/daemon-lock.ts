import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../shared/data-dir-secure.js'
import { type MkdirLockOptions, withMkdirLock } from '../shared/mkdir-lock.js'

const DAEMON_LOCK_DIRNAME = 'daemon.lock'

function getDaemonLockPath(dataDir: string): string {
  return join(dataDir, DAEMON_LOCK_DIRNAME)
}

export async function withDaemonStartupLock<T>(
  dataDir: string = DATA_DIR,
  fn: () => Promise<T>,
  options: MkdirLockOptions = {},
): Promise<T> {
  await mkdir(dataDir, { recursive: true })
  return withMkdirLock(getDaemonLockPath(dataDir), fn, options)
}
