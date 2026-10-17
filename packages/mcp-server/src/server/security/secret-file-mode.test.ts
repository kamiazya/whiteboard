import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from '../../shared/test-utils/chmod-is-observable.js'
import { assertSecretFileIsOwnerOnly, writeSecretFileAtomicSync } from './secret-file-mode.js'

// What the write did to the disk, in order: which path a descriptor was
// synced for, and when the rename ran. Records only; every call is real.
const fsEvents = vi.hoisted(() => ({
  log: [] as string[],
  paths: new Map<number, string>(),
  /** A sync of this path fails with this code, as a disk would report it. */
  failSync: undefined as { path: string; code: string } | undefined,
  /** An open of this path fails with this code, as Windows does for a directory. */
  failOpen: undefined as { path: string; code: string } | undefined,
}))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return {
    ...real,
    openSync: ((...args: Parameters<typeof real.openSync>) => {
      if (fsEvents.failOpen?.path === String(args[0])) {
        throw Object.assign(new Error(`open failed: ${fsEvents.failOpen.code}`), {
          code: fsEvents.failOpen.code,
        })
      }
      const fd = real.openSync(...args)
      fsEvents.paths.set(fd, String(args[0]))
      return fd
    }) as typeof real.openSync,
    fsyncSync: (fd: number) => {
      const path = fsEvents.paths.get(fd) ?? `fd ${fd}`
      if (fsEvents.failSync?.path === path) {
        throw Object.assign(new Error(`sync failed: ${fsEvents.failSync.code}`), {
          code: fsEvents.failSync.code,
        })
      }
      real.fsyncSync(fd)
      fsEvents.log.push(`sync ${path}`)
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      real.renameSync(...args)
      fsEvents.log.push(`rename ${String(args[0])}`)
    },
  }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-secret-file-mode-'))
})
afterEach(() => {
  fsEvents.log = []
  fsEvents.paths.clear()
  fsEvents.failSync = undefined
  fsEvents.failOpen = undefined
  rmSync(dir, { recursive: true, force: true })
})

const modeOf = (path: string) => statSync(path).mode & 0o777

describe('assertSecretFileIsOwnerOnly', () => {
  it.skipIf(!CHMOD_IS_OBSERVABLE)('accepts an owner-only file', () => {
    const file = join(dir, 'key.json')
    writeFileSync(file, '{}')
    chmodSync(file, 0o600)

    expect(() => assertSecretFileIsOwnerOnly(file)).not.toThrow()
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'refuses a group-readable file, naming the path and the fix',
    () => {
      const file = join(dir, 'key.json')
      writeFileSync(file, '{}')
      chmodSync(file, 0o640)

      expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(/group or other/i)
      expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(
        new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      )
      expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(/chmod 600/)
    },
  )

  it.skipIf(!CHMOD_IS_OBSERVABLE)('refuses an other-readable file', () => {
    const file = join(dir, 'key.json')
    writeFileSync(file, '{}')
    chmodSync(file, 0o604)

    expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(/group or other/i)
  })

  // Absence is the caller's business — both key stores answer it by
  // generating a fresh secret, and a guard that turned "no key yet" into a
  // startup failure would break first boot.
  it('says nothing about a file that does not exist', () => {
    expect(() => assertSecretFileIsOwnerOnly(join(dir, 'absent.json'))).not.toThrow()
  })
})

describe('writeSecretFileAtomicSync', () => {
  it.skipIf(!CHMOD_IS_OBSERVABLE)('creates the file owner-only', () => {
    const file = join(dir, 'key.json')
    writeSecretFileAtomicSync(file, '{"a":1}\n')

    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
    expect(modeOf(file)).toBe(0o600)
  })

  // The defect this helper exists for, measured rather than argued:
  // `writeFileSync`'s `mode` option applies only when the file is CREATED, so
  // a leftover `<file>.tmp` from a crashed write keeps whatever bits it had
  // and the rename carries them onto the secret. Verified against Node: a
  // 0o644 file rewritten with `{ mode: 0o600 }` reads back 0o644.
  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'tightens a leftover temp file instead of inheriting its bits',
    () => {
      const file = join(dir, 'key.json')
      const leftover = `${file}.tmp`
      writeFileSync(leftover, 'stale')
      chmodSync(leftover, 0o644)

      writeSecretFileAtomicSync(file, '{"a":1}\n')

      expect(modeOf(file)).toBe(0o600)
      expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
    },
  )

  // The staging name is fixed, so a link left there would otherwise carry the
  // secret to wherever it points; the stale name is replaced, never followed.
  it('never writes the secret through a symlink left at the temp name', () => {
    const file = join(dir, 'key.json')
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'untouched')
    symlinkSync(outside, `${file}.tmp`)

    writeSecretFileAtomicSync(file, '{"a":1}\n')

    expect(readFileSync(outside, 'utf8')).toBe('untouched')
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'tightens a pre-existing directory instead of inheriting its bits',
    () => {
      const nested = join(dir, 'data')
      mkdirSync(nested)
      chmodSync(nested, 0o755)

      writeSecretFileAtomicSync(join(nested, 'key.json'), '{}\n')

      expect(modeOf(nested)).toBe(0o700)
    },
  )

  /**
   * The ATOMIC half of the name, which nothing watched until a mutation check
   * found it: replacing the temp-file-and-rename with a direct write left all
   * three callers' suites green — daemon-identity, macaroon-root-key and the
   * server-mode record alike.
   *
   * The inode is the discriminator, and it is the property rather than an
   * implementation detail. A direct write opens the destination `O_TRUNC`, so
   * the same inode is empty for as long as the write takes and a concurrent
   * reader sees a truncated file; a rename swaps a fully-written inode in, so
   * a reader sees the old bytes or the new ones and never a half file.
   * Measured: a direct rewrite keeps the inode, a rename changes it.
   */
  it('swaps a new inode into place rather than truncating the old one', () => {
    const file = join(dir, 'key.json')
    writeSecretFileAtomicSync(file, 'old')
    const before = statSync(file).ino

    writeSecretFileAtomicSync(file, 'new')

    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(statSync(file).ino).not.toBe(before)
  })

  it('syncs the staged secret before the rename names it, and the directory after', () => {
    // A zero-length key file reads as invalid and is minted over: a new root
    // key stops every issued token verifying, a new identity is someone else.
    const file = join(dir, 'key.json')
    writeSecretFileAtomicSync(file, '{"k":1}')

    const renamed = fsEvents.log.findIndex((e) => e.startsWith('rename '))
    expect(renamed).toBeGreaterThan(-1)
    const stagedPath = fsEvents.log[renamed]?.slice('rename '.length)
    expect(fsEvents.log.slice(0, renamed)).toContain(`sync ${stagedPath}`)
    expect(fsEvents.log.slice(renamed + 1)).toContain(`sync ${dir}`)
  })

  it('fails the write when the directory sync reports a storage error', () => {
    fsEvents.failSync = { path: dir, code: 'EIO' }
    expect(() => writeSecretFileAtomicSync(join(dir, 'key.json'), '{}')).toThrow(
      expect.objectContaining({ code: 'EIO' }),
    )
  })

  // Each code says the platform cannot sync a directory at all, and each can
  // arrive from either step: Windows refuses the open (EISDIR, EPERM,
  // EACCES), some filesystems refuse the fsync of an open directory.
  const CANNOT_SYNC_DIRECTORY = ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF']

  it.each(
    CANNOT_SYNC_DIRECTORY,
  )('lets the write land where the directory cannot be opened (%s)', (code) => {
    fsEvents.failOpen = { path: dir, code }
    writeSecretFileAtomicSync(join(dir, 'key.json'), '{}')
    expect(readFileSync(join(dir, 'key.json'), 'utf8')).toBe('{}')
  })

  it.each(
    CANNOT_SYNC_DIRECTORY,
  )('lets the write land where the directory cannot be synced (%s)', (code) => {
    fsEvents.failSync = { path: dir, code }
    writeSecretFileAtomicSync(join(dir, 'key.json'), '{}')
    expect(readFileSync(join(dir, 'key.json'), 'utf8')).toBe('{}')
  })

  it('fails the write when opening the directory reports a storage error', () => {
    fsEvents.failOpen = { path: dir, code: 'EIO' }
    expect(() => writeSecretFileAtomicSync(join(dir, 'key.json'), '{}')).toThrow(
      expect.objectContaining({ code: 'EIO' }),
    )
  })

  it('leaves no temp file behind', () => {
    const file = join(dir, 'key.json')
    writeSecretFileAtomicSync(file, 'contents')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  // A fixed staging name means a leftover is reused by the next write, and it
  // holds a secret that never became the live one.
  it('removes the staged secret when syncing it fails, and rethrows', () => {
    const file = join(dir, 'key.json')
    writeFileSync(file, 'old')
    fsEvents.failSync = { path: `${file}.tmp`, code: 'EIO' }

    expect(() => writeSecretFileAtomicSync(file, 'new')).toThrow(
      expect.objectContaining({ code: 'EIO' }),
    )
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('old')
  })

  it('removes the staged secret when the rename fails, and rethrows', () => {
    const file = join(dir, 'key.json')
    mkdirSync(join(file, 'occupied'), { recursive: true })

    expect(() => writeSecretFileAtomicSync(file, 'new')).toThrow()
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('replaces an existing secret and leaves it owner-only', () => {
    const file = join(dir, 'key.json')
    writeFileSync(file, 'old')
    chmodSync(file, 0o644)

    writeSecretFileAtomicSync(file, 'new')

    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(modeOf(file)).toBe(0o600)
  })
})
