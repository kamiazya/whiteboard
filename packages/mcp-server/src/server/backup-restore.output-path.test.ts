import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectOutputPath, isSafeSourcePath } from './backup-restore.js'

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

  it('refuses a path under a symlinked ancestor, even a missing one', async () => {
    const real = join(base, 'real')
    await mkdir(real)
    const link = join(base, 'link')
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

  it('refuses a source under a symlinked ancestor', async () => {
    const real = join(base, 'real')
    await mkdir(join(real, 'data'), { recursive: true })
    const link = join(base, 'link')
    await symlink(real, link)
    expect(await isSafeSourcePath(join(link, 'data'))).toBe(false)
  })
})
