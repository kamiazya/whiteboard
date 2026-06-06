import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../shared/data-dir-secure.js'
import { isPidAlive } from './daemon-registry.js'

const DAEMON_LOCK_DIRNAME = 'daemon.lock'
const DAEMON_LOCK_OWNER_FILENAME = 'owner.json'

interface DaemonLockOwner {
  pid: number
  startedAt: string
}

function getDaemonLockPath(dataDir: string): string {
  return join(dataDir, DAEMON_LOCK_DIRNAME)
}

function getDaemonLockOwnerPath(dataDir: string): string {
  return join(getDaemonLockPath(dataDir), DAEMON_LOCK_OWNER_FILENAME)
}

function isValidOwner(value: unknown): value is DaemonLockOwner {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pid?: unknown }).pid === 'number' &&
    typeof (value as { startedAt?: unknown }).startedAt === 'string'
  )
}

async function writeOwnerMetadata(dataDir: string): Promise<void> {
  const owner: DaemonLockOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  await writeFile(getDaemonLockOwnerPath(dataDir), JSON.stringify(owner, null, 2))
}

async function loadOwnerMetadata(dataDir: string): Promise<DaemonLockOwner | null> {
  try {
    const raw = JSON.parse(await readFile(getDaemonLockOwnerPath(dataDir), 'utf-8')) as unknown
    return isValidOwner(raw) ? raw : null
  } catch {
    return null
  }
}

export async function withDaemonStartupLock<T>(
  dataDir: string = DATA_DIR,
  fn: () => Promise<T>,
  options: { retryDelayMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? 50
  const timeoutMs = options.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  const lockPath = getDaemonLockPath(dataDir)
  await mkdir(dataDir, { recursive: true })

  while (true) {
    try {
      await mkdir(lockPath, { recursive: false })
      await writeOwnerMetadata(dataDir)
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw err
      }
      const owner = await loadOwnerMetadata(dataDir)
      if (owner && !isPidAlive(owner.pid)) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error('Daemon startup lock timeout')
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}
