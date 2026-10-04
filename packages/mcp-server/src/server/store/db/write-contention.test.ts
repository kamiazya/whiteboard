import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLease } from '../lease.js'
import { closeDb, DB_FILENAME, getDb } from './index.js'
import { clearPrepareCache, prepareDataDir } from './prepare.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

// The other process: opens the same file the way a second daemon or the stdio
// agent does, takes the write lock, says so, and holds it until told to let go.
// Released by a message rather than a timer so the test decides when contention
// ends and nothing here waits on the clock to find out.
const HOLDER = `
import { createClient } from '@libsql/client'
import { createInterface } from 'node:readline'
const client = createClient({ url: process.argv[1] })
const tx = await client.transaction('write')
await tx.execute({ sql: "insert into leases (name, holder, expiresAt) values ('held', 'other', 1)", args: [] })
console.log('held')
for await (const _ of createInterface({ input: process.stdin })) break
await tx.commit()
client.close()
`

interface Holder {
  release(): Promise<void>
}

async function holdWriteLock(dataDir: string): Promise<Holder> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--input-type=module', '-e', HOLDER, `file:${join(dataDir, DB_FILENAME)}`],
    { cwd: packageRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`holder exited with ${code}`)),
    )
  })
  exited.catch(() => {})
  const lines = createInterface({ input: child.stdout })
  let held = false
  for await (const line of lines) {
    if (line === 'held') {
      held = true
      break
    }
  }
  lines.close()
  if (!held) throw new Error('holder exited before taking the write lock')
  return {
    async release() {
      child.stdin.end('release\n')
      await exited
    },
  }
}

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-write-contention-'))
  await prepareDataDir(dataDir)
})
afterEach(async () => {
  await closeDb(dataDir)
  clearPrepareCache()
  await rm(dataDir, { recursive: true, force: true })
})

/**
 * Cost: one child process, about 0.3s of wall clock a test.
 *
 * The stdio agent and the daemon are two processes over one data directory, so
 * the second writer to arrive meets a lock the first holds. The handle's
 * busy_timeout is 0 (a longer one blocks the event loop for its whole
 * duration, so it is not the answer), which makes that arrival an instant
 * SQLITE_BUSY unless the store waits for it itself.
 */
describe('a write that meets another process holding the write lock', () => {
  it('is refused at once with SQLITE_BUSY', async () => {
    const holder = await holdWriteLock(dataDir)
    try {
      const db = await getDb(dataDir)
      await expect(
        acquireLease(db, { name: 'backup', holder: 'me', ttlMs: 60_000, nowMs: 1 }),
      ).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    } finally {
      await holder.release()
    }
  })
})
