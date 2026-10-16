import { chmodSync, chownSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { chmod, chown, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from '../shared/test-utils/chmod-is-observable.js'
import { makeWritableByOthers } from '../shared/test-utils/writable-by-others.js'
import { inspectOutputPath, isSafeSourcePath } from './backup-restore.js'

// A uid that is neither root nor this process, for a directory another user
// owns. Staging one takes the privilege to chown, so it is PROBED by trying
// rather than inferred from `getuid() === 0`: a user namespace can grant or
// withhold it either way.
const OTHER_UID = 65534
function probeCanChownToAnotherUser(): boolean {
  const uid = process.getuid?.()
  if (uid === undefined || uid === OTHER_UID) return false
  const dir = mkdtempSync(join(tmpdir(), 'wb-chown-probe-'))
  try {
    chownSync(dir, OTHER_UID, OTHER_UID)
    return statSync(dir).uid === OTHER_UID
  } catch {
    return false
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
}
const CAN_CHOWN_TO_ANOTHER_USER = probeCanChownToAnotherUser()
const HAS_POSIX_OWNERS = process.getuid !== undefined && CHMOD_IS_OBSERVABLE

let base: string

beforeEach(async () => {
  // Resolved, so a platform whose temp dir is itself a symlink does not turn
  // every case into a symlink case.
  base = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-output-path-')))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe.each([
  { requireDirectory: false },
  { requireDirectory: true },
])('inspectOutputPath with requireDirectory=$requireDirectory', ({ requireDirectory }) => {
  it('reports a path that does not exist yet as missing', async () => {
    expect(await inspectOutputPath(join(base, 'new'), { requireDirectory })).toBe('missing')
  })

  it('reports a path whose parents are also missing as missing', async () => {
    expect(await inspectOutputPath(join(base, 'a', 'b'), { requireDirectory })).toBe('missing')
  })

  it('reports an existing directory as present', async () => {
    const dir = join(base, 'dir')
    await mkdir(dir)
    expect(await inspectOutputPath(dir, { requireDirectory })).toBe('present')
  })

  it('refuses a final component that is a symlink to a directory', async () => {
    const real = join(base, 'real')
    await mkdir(real)
    const link = join(base, 'link')
    await symlink(real, link)
    expect(await inspectOutputPath(link, { requireDirectory })).toBe('unsafe')
  })

  it('refuses a dangling symlink', async () => {
    const link = join(base, 'dangling')
    await symlink(join(base, 'nowhere'), link)
    expect(await inspectOutputPath(link, { requireDirectory })).toBe('unsafe')
  })

  it('refuses a path under a symlinked ancestor others could have planted, even a missing one', async () => {
    const real = join(base, 'real')
    await mkdir(real)
    const link = join(await makeWritableByOthers(join(base, 'shared')), 'link')
    await symlink(real, link)
    expect(await inspectOutputPath(join(link, 'child'), { requireDirectory })).toBe('unsafe')
  })

  it('refuses a plain file', async () => {
    const file = join(base, 'file.txt')
    await writeFile(file, 'x')
    expect(await inspectOutputPath(file, { requireDirectory })).toBe('unsafe')
  })
})

// The one place the two variants differ: an entry that is neither a
// directory, a file nor a symlink.
describe.skipIf(process.platform === 'win32')('inspectOutputPath with a socket entry', () => {
  async function withSocket(path: string, run: () => Promise<void>): Promise<void> {
    const server = createServer()
    await new Promise<void>((resolveListen) => server.listen(path, resolveListen))
    try {
      await run()
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  }

  it('leaves it to the caller when a directory is not required', async () => {
    const path = join(base, 's.sock')
    await withSocket(path, async () => {
      expect(await inspectOutputPath(path, { requireDirectory: false })).toBe('present')
    })
  })

  it('refuses it when a directory is required', async () => {
    const path = join(base, 's.sock')
    await withSocket(path, async () => {
      expect(await inspectOutputPath(path, { requireDirectory: true })).toBe('unsafe')
    })
  })
})

describe('a path that cannot be examined', () => {
  // A component below a plain file answers ENOTDIR, which is not "missing".
  async function underAFile(): Promise<string> {
    const file = join(base, 'file.txt')
    await writeFile(file, 'x')
    return join(file, 'child')
  }

  it('rejects instead of being judged for an output path', async () => {
    await expect(
      inspectOutputPath(await underAFile(), { requireDirectory: false }),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('is not a safe source', async () => {
    expect(await isSafeSourcePath(await underAFile())).toBe(false)
  })
})

describe('isSafeSourcePath', () => {
  it('accepts a real directory', async () => {
    expect(await isSafeSourcePath(base)).toBe(true)
  })

  it('accepts a path that does not exist', async () => {
    expect(await isSafeSourcePath(join(base, 'missing'))).toBe(true)
  })

  it('refuses a symlinked source', async () => {
    const link = join(base, 'link')
    await symlink(base, link)
    expect(await isSafeSourcePath(link)).toBe(false)
  })

  it('refuses a source under a symlinked ancestor others could have planted', async () => {
    const real = join(base, 'real')
    await mkdir(join(real, 'data'), { recursive: true })
    const link = join(await makeWritableByOthers(join(base, 'shared')), 'link')
    await symlink(real, link)
    expect(await isSafeSourcePath(join(link, 'data'))).toBe(false)
  })
})

// A symlink ABOVE the path is judged by the directory holding it: only root or
// this user may have been able to create it there. That is what admits macOS's
// `/tmp -> /private/tmp` (in a root-owned `/` nobody else may write) and still
// refuses a link planted in a shared directory. A link that IS the path stays
// refused wherever it sits.
describe.skipIf(!HAS_POSIX_OWNERS)('a symlink above the path, judged by its directory', () => {
  async function linkIn(dir: string, mode: number): Promise<string> {
    await mkdir(dir, { recursive: true })
    await chmod(dir, mode)
    const real = join(base, 'real')
    await mkdir(join(real, 'data'), { recursive: true })
    const link = join(dir, 'link')
    await symlink(real, link)
    return link
  }

  it.each([
    '700',
    '755',
  ])('follows one in a directory this user owns with mode %s', async (mode) => {
    const link = await linkIn(join(base, 'own'), Number.parseInt(mode, 8))
    for (const requireDirectory of [false, true]) {
      expect(await inspectOutputPath(join(link, 'out'), { requireDirectory })).toBe('missing')
      expect(await inspectOutputPath(join(link, 'data'), { requireDirectory })).toBe('present')
    }
    expect(await isSafeSourcePath(join(link, 'data'))).toBe(true)
  })

  it.each([
    '777',
    '775',
    '757',
    '1777',
  ])('refuses one in a directory with mode %s', async (mode) => {
    const link = await linkIn(join(base, 'shared'), Number.parseInt(mode, 8))
    for (const requireDirectory of [false, true]) {
      expect(await inspectOutputPath(join(link, 'out'), { requireDirectory })).toBe('unsafe')
    }
    expect(await isSafeSourcePath(join(link, 'data'))).toBe(false)
  })

  it('still refuses a path that is itself a symlink in a directory this user owns', async () => {
    const link = await linkIn(join(base, 'own'), 0o755)
    for (const requireDirectory of [false, true]) {
      expect(await inspectOutputPath(link, { requireDirectory })).toBe('unsafe')
    }
    expect(await isSafeSourcePath(link)).toBe(false)
  })

  it.skipIf(!CAN_CHOWN_TO_ANOTHER_USER)(
    'refuses one in a directory another user owns, even with mode 755',
    async () => {
      const dir = join(base, 'theirs')
      const link = await linkIn(dir, 0o755)
      await chown(dir, OTHER_UID, OTHER_UID)
      for (const requireDirectory of [false, true]) {
        expect(await inspectOutputPath(join(link, 'out'), { requireDirectory })).toBe('unsafe')
      }
      expect(await isSafeSourcePath(join(link, 'data'))).toBe(false)
    },
  )
})
