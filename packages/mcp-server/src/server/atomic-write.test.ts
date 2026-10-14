import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PENDING_WRITES_DIRNAME, writeFileAtomicStaged } from './atomic-write.js'

// What the staged write did to the disk, in order: which path a handle was
// synced for, and when the rename ran. Records only; every call is real.
const fsEvents = vi.hoisted(() => ({
  log: [] as string[],
  /** A sync of this path fails with this code, as a disk would report it. */
  failSync: undefined as { path: string; code: string } | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      const path = String(args[0])
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (fsEvents.failSync?.path === path) {
          throw Object.assign(new Error(`sync failed: ${fsEvents.failSync.code}`), {
            code: fsEvents.failSync.code,
          })
        }
        await sync()
        fsEvents.log.push(`sync ${path}`)
      }
      return handle
    }) as typeof real.open,
    rename: (async (...args: Parameters<typeof real.rename>) => {
      await real.rename(...args)
      fsEvents.log.push(`rename ${String(args[0])}`)
    }) as typeof real.rename,
  }
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-atomic-write-'))
})
afterEach(async () => {
  fsEvents.log = []
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomicStaged', () => {
  it('never lets a reader see the target half-written', async () => {
    const target = join(dir, 'thing.bin')
    // Large enough that the write spans many reads. A small payload can
    // finish inside one scheduler turn and hide the window entirely.
    const bytes = new Uint8Array(6 * 1024 * 1024).fill(0x41)
    await writeFileAtomicStaged(dir, target, bytes)

    const reads: Array<Promise<number>> = []
    const rewriting = writeFileAtomicStaged(dir, target, bytes)
    for (let i = 0; i < 8; i++) {
      reads.push(
        readFile(target)
          .then((b) => b.length)
          .catch(() => -1),
      )
    }
    const seen = await Promise.all(reads)
    await rewriting

    expect(seen).toEqual(Array.from({ length: 8 }, () => bytes.length))
  })

  it('stages outside the target directory, so a copy of it never sees a temp file', async () => {
    const targetDir = join(dir, 'files')
    await mkdir(targetDir, { recursive: true })
    await writeFileAtomicStaged(dir, join(targetDir, 'a.png'), new Uint8Array(64))

    expect(await readdir(targetDir)).toEqual(['a.png'])
    expect(await readdir(join(dir, PENDING_WRITES_DIRNAME))).toEqual([])
  })

  it('leaves nothing staged when the rename cannot land', async () => {
    // A target whose parent does not exist: the write succeeds, the rename
    // fails, and the staged bytes must not survive it.
    await expect(
      writeFileAtomicStaged(dir, join(dir, 'no', 'such', 'dir', 'x.bin'), new Uint8Array(8)),
    ).rejects.toThrow()
    expect(await readdir(join(dir, PENDING_WRITES_DIRNAME))).toEqual([])
  })

  it('fails the write when the directory sync reports a storage error', async () => {
    const target = join(dir, 'shard', 'blob')
    await mkdir(join(dir, 'shard'), { recursive: true })
    fsEvents.failSync = { path: join(dir, 'shard'), code: 'EIO' }
    try {
      await expect(writeFileAtomicStaged(dir, target, new Uint8Array([1]))).rejects.toMatchObject({
        code: 'EIO',
      })
    } finally {
      fsEvents.failSync = undefined
    }
  })

  it('lets the write land where the directory cannot be synced at all', async () => {
    const target = join(dir, 'shard', 'blob')
    await mkdir(join(dir, 'shard'), { recursive: true })
    fsEvents.failSync = { path: join(dir, 'shard'), code: 'EINVAL' }
    try {
      await writeFileAtomicStaged(dir, target, new Uint8Array([1]))
      expect([...(await readFile(target))]).toEqual([1])
    } finally {
      fsEvents.failSync = undefined
    }
  })

  it('syncs the staged bytes before the rename names them', async () => {
    // Without it a crash after the rename can leave the final name on a
    // zero-length file: a filesystem need not order a new file's data before
    // a rename of it.
    await writeFileAtomicStaged(dir, join(dir, 'durable.bin'), new Uint8Array(16))

    const renamed = fsEvents.log.findIndex((e) => e.startsWith('rename '))
    expect(renamed).toBeGreaterThan(-1)
    const stagedPath = fsEvents.log[renamed]?.slice('rename '.length)
    expect(fsEvents.log.slice(0, renamed)).toContain(`sync ${stagedPath}`)
  })
})
