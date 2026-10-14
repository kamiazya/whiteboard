import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from './test-utils/chmod-is-observable.js'
import { syncTree, writeFileAtomic } from './write-file-atomic.js'

// The chmod after the write is best-effort, so a test can refuse it to see
// what the write carried on its own.
const chmodGate = vi.hoisted(() => ({ refuse: false }))
// What the write did to the disk, in order: which path a handle was synced
// for, and when the rename ran. Records only; every call is real.
const fsEvents = vi.hoisted(() => ({
  log: [] as string[],
  /** A sync of this path fails with this code, as a disk would report it. */
  failSync: undefined as { path: string; code: string } | undefined,
  /** An open of this path fails with this code, as Windows does for a directory. */
  failOpen: undefined as { path: string; code: string } | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    chmod: (...args: Parameters<typeof real.chmod>) =>
      chmodGate.refuse
        ? Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
        : real.chmod(...args),
    open: (async (...args: Parameters<typeof real.open>) => {
      if (fsEvents.failOpen?.path === String(args[0])) {
        throw Object.assign(new Error(`open failed: ${fsEvents.failOpen.code}`), {
          code: fsEvents.failOpen.code,
        })
      }
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

/**
 * The mode a file asking for 0o666 is born with under this process's umask.
 * PROBED: the two mode cases below only distinguish anything when the umask
 * narrows a new file, and still leaves it looser than owner-only.
 */
function probeBornMode(): number {
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-umask-probe-'))
  try {
    const file = join(probeDir, 'f')
    writeFileSync(file, 'x', { mode: 0o666 })
    return statSync(file).mode & 0o777
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
const BORN_MODE = probeBornMode()
const UMASK_NARROWS = CHMOD_IS_OBSERVABLE && BORN_MODE !== 0o666
const UMASK_LEAVES_GROUP_OR_OTHER = CHMOD_IS_OBSERVABLE && (BORN_MODE & 0o066) !== 0

describe('writeFileAtomic', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'write-file-atomic-'))
  })
  afterEach(() => {
    chmodGate.refuse = false
    fsEvents.log = []
    fsEvents.failSync = undefined
    fsEvents.failOpen = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves the file holding the bytes, and nothing else beside it', async () => {
    const target = join(dir, 'out.bin')
    await writeFileAtomic(target, new Uint8Array([1, 2, 3]))
    expect([...readFileSync(target)]).toEqual([1, 2, 3])
    expect(readdirSync(dir)).toEqual(['out.bin'])
  })

  it('accepts a string and replaces an existing file whole', async () => {
    const target = join(dir, 'out.txt')
    writeFileSync(target, 'a much longer previous body')
    await writeFileAtomic(target, 'short')
    expect(readFileSync(target, 'utf-8')).toBe('short')
    expect(readdirSync(dir)).toEqual(['out.txt'])
  })

  it('two concurrent writes to one target never interleave', async () => {
    const target = join(dir, 'race.txt')
    const a = 'a'.repeat(200_000)
    const b = 'b'.repeat(200_000)
    await Promise.all([writeFileAtomic(target, a), writeFileAtomic(target, b)])
    expect([a, b]).toContain(readFileSync(target, 'utf-8'))
    expect(readdirSync(dir)).toEqual(['race.txt'])
  })

  it('removes its temp file and rethrows when the rename fails', async () => {
    const target = join(dir, 'is-a-dir')
    mkdirSync(target)
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['is-a-dir'])
  })

  it('syncs the staged bytes before the rename names them', async () => {
    // Without it a crash after the rename can leave the final name on a
    // zero-length file: a filesystem need not order a new file's data before
    // a rename of it.
    await writeFileAtomic(join(dir, 'durable.bin'), new Uint8Array(16))

    const renamed = fsEvents.log.findIndex((e) => e.startsWith('rename '))
    expect(renamed).toBeGreaterThan(-1)
    const stagedPath = fsEvents.log[renamed]?.slice('rename '.length)
    expect(fsEvents.log.slice(0, renamed)).toContain(`sync ${stagedPath}`)
  })

  it('syncs the target directory after the rename, so the rename survives too', async () => {
    await writeFileAtomic(join(dir, 'durable.bin'), new Uint8Array(16))

    const renamed = fsEvents.log.findIndex((e) => e.startsWith('rename '))
    expect(renamed).toBeGreaterThan(-1)
    expect(fsEvents.log.slice(renamed + 1)).toContain(`sync ${dir}`)
  })

  it('fails the write when the directory sync reports a storage error', async () => {
    fsEvents.failSync = { path: dir, code: 'EIO' }
    await expect(writeFileAtomic(join(dir, 'blob'), new Uint8Array([1]))).rejects.toMatchObject({
      code: 'EIO',
    })
  })

  // Each code says the platform cannot sync a directory at all, and each can
  // arrive from either step: Windows refuses the open (EISDIR, EPERM,
  // EACCES), some filesystems refuse the fsync of an open directory.
  const CANNOT_SYNC_DIRECTORY = ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF']

  it.each(
    CANNOT_SYNC_DIRECTORY,
  )('lets the write land where the directory cannot be opened (%s)', async (code) => {
    fsEvents.failOpen = { path: dir, code }
    await writeFileAtomic(join(dir, 'blob'), new Uint8Array([1]))
    expect([...readFileSync(join(dir, 'blob'))]).toEqual([1])
  })

  it.each(
    CANNOT_SYNC_DIRECTORY,
  )('lets the write land where the directory cannot be synced (%s)', async (code) => {
    fsEvents.failSync = { path: dir, code }
    await writeFileAtomic(join(dir, 'blob'), new Uint8Array([1]))
    expect([...readFileSync(join(dir, 'blob'))]).toEqual([1])
  })

  it('fails the write when opening the directory reports a storage error', async () => {
    fsEvents.failOpen = { path: dir, code: 'EIO' }
    await expect(writeFileAtomic(join(dir, 'blob'), new Uint8Array([1]))).rejects.toMatchObject({
      code: 'EIO',
    })
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('honours the mode when one is given', async () => {
    const target = join(dir, 'secret.json')
    await writeFileAtomic(target, '{}', { mode: 0o600 })
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('honours the mode when replacing a looser file', async () => {
    const target = join(dir, 'secret.json')
    writeFileSync(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, '{}', { mode: 0o600 })
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it.skipIf(!UMASK_NARROWS)(
    'applies a mode wider than the umask lets a new file have',
    async () => {
      const target = join(dir, 'shared.json')
      await writeFileAtomic(target, '{}', { mode: 0o666 })
      expect(statSync(target).mode & 0o777).toBe(0o666)
    },
  )

  it.skipIf(!UMASK_LEAVES_GROUP_OR_OTHER)(
    'carries the mode in the write itself, so a refused chmod still leaves it owner-only',
    async () => {
      chmodGate.refuse = true
      const target = join(dir, 'secret.json')
      await writeFileAtomic(target, '{}', { mode: 0o600 })
      expect(statSync(target).mode & 0o777).toBe(0o600)
    },
  )

  // Both premises hold under every umask a CI runner uses (0022 or 0002), so
  // the two cases above cannot quietly skip there.
  it.runIf(process.env.CI === 'true')('can observe both mode premises on CI', () => {
    expect({ UMASK_NARROWS, UMASK_LEAVES_GROUP_OR_OTHER }).toEqual({
      UMASK_NARROWS: true,
      UMASK_LEAVES_GROUP_OR_OTHER: true,
    })
  })
})

describe('syncTree', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-tree-'))
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'top.json'), '{}')
    writeFileSync(join(dir, 'a', 'b', 'deep.bin'), 'x')
  })
  afterEach(() => {
    fsEvents.log = []
    fsEvents.failSync = undefined
    fsEvents.failOpen = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('syncs every file and every directory, the root last', async () => {
    await syncTree(dir)

    expect(fsEvents.log).toEqual(
      expect.arrayContaining([
        `sync ${join(dir, 'top.json')}`,
        `sync ${join(dir, 'a', 'b', 'deep.bin')}`,
      ]),
    )
    const dirs = fsEvents.log.filter((e) => !e.endsWith('.json') && !e.endsWith('.bin'))
    expect(dirs).toEqual([`sync ${join(dir, 'a', 'b')}`, `sync ${join(dir, 'a')}`, `sync ${dir}`])
    expect(fsEvents.log.at(-1)).toBe(`sync ${dir}`)
  })

  it('fails when a file inside reports a storage error', async () => {
    fsEvents.failSync = { path: join(dir, 'a', 'b', 'deep.bin'), code: 'EIO' }
    await expect(syncTree(dir)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('forgives a file the platform cannot sync through a read-only handle', async () => {
    fsEvents.failSync = { path: join(dir, 'top.json'), code: 'EPERM' }
    await syncTree(dir)
    expect(fsEvents.log.at(-1)).toBe(`sync ${dir}`)
  })
})
