// Two openers judge the same stale lock, and the other one acts between this
// one's judgement and its move. The interleavings are staged through mocked
// `open` and `rename`; each replays the other opener's real steps.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../../log.js'

type Other =
  /** It moved the stale lock away first and has not created its own yet. */
  | 'moved-first'
  /** It moved the stale lock aside, dropped it, and created its own. */
  | 'replaced'
  /** The same, keeping the moved file, so its new lock cannot take that inode. */
  | 'replaced-keeping-aside'
  /** The same, its new lock written into the very inode it moved aside. */
  | 'replaced-same-inode'
  /** It held the lock when this opener's create failed, and released it before the read. */
  | 'released'

const plan = vi.hoisted(() => ({
  other: null as Other | null,
  successorText: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      if (plan.other === 'released') {
        plan.other = null
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      return actual.open(...args)
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const other = plan.other
      plan.other = null
      const aside = `${from}.other-aside`
      if (other === 'moved-first') {
        await actual.unlink(from)
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      if (other === 'replaced' || other === 'replaced-keeping-aside') {
        await actual.rename(from, aside)
        if (other === 'replaced') await actual.unlink(aside)
        await actual.writeFile(from, plan.successorText)
      }
      if (other === 'replaced-same-inode') {
        await actual.rename(from, aside)
        await actual.rename(aside, from)
        await actual.writeFile(from, plan.successorText)
      }
      return actual.rename(from, to)
    }),
  }
})

const { MIGRATION_LOCK_FILENAME, withMigrationLock } = await import('./migration-lock.js')

let dataDir: string
let lockPath: string
let logs: ReturnType<typeof captureLogsForTests>
const children: ChildProcess[] = []

beforeEach(async () => {
  plan.other = null
  dataDir = await mkdtemp(join(tmpdir(), 'wb-migration-lock-race-'))
  lockPath = join(dataDir, MIGRATION_LOCK_FILENAME)
  logs = captureLogsForTests('warning')
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  if (pid === undefined) throw new Error('could not spawn a process to take a pid from')
  await writeFile(lockPath, String(pid))
  // Older than any successor's write, so a successor's mtime always differs.
  const longAgo = new Date(Date.now() - 60_000)
  await utimes(lockPath, longAgo, longAgo)
})
afterEach(async () => {
  logs.restore()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await rm(dataDir, { recursive: true, force: true })
})

async function liveProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: 'ignore',
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('spawned process has no pid')
  return child.pid
}

describe('racing openers of one stale migration lock', () => {
  it.each([
    'moved-first',
    'released',
  ] as const)('retries the create when the other opener left nothing behind (%s)', async (other) => {
    if (other === 'released') await rm(lockPath)
    plan.other = other
    const work = vi.fn(async () => 'done')
    await expect(withMigrationLock(dataDir, work, { timeoutMs: 1_000, pollMs: 10 })).resolves.toBe(
      'done',
    )
    expect(await readdir(dataDir)).toEqual([])
  })

  it.each([
    'replaced',
    'replaced-keeping-aside',
    'replaced-same-inode',
  ] as const)("puts the other opener's fresh lock back and waits for it (%s)", async (other) => {
    plan.successorText = String(await liveProcessPid())
    plan.other = other
    const work = vi.fn(async () => {})
    await expect(withMigrationLock(dataDir, work, { timeoutMs: 300, pollMs: 10 })).rejects.toThrow(
      `waiting for process ${plan.successorText}`,
    )
    expect(work).not.toHaveBeenCalled()
    expect(await readFile(lockPath, 'utf8')).toBe(plan.successorText)
    const leftovers = (await readdir(dataDir)).filter((name) => !name.endsWith('.other-aside'))
    expect(leftovers).toEqual([MIGRATION_LOCK_FILENAME])
  })
})
