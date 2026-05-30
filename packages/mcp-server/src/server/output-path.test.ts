import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Wrap node:fs/promises so a single test can `mockRejectedValueOnce` on
// stat() to inject an EACCES without depending on real kernel permissions.
// Every other call still hits the real implementation, so happy-path tests
// continue to round-trip through the disk they always have.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, stat: vi.fn(real.stat) }
})

const fsp = await import('node:fs/promises')
const { OutputPathError, validateOutputPath } = await import('./output-path.js')

describe('validateOutputPath', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-output-path-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('accepts an absolute path that does not exist yet', async () => {
    await expect(
      validateOutputPath(join(tempDir, 'fresh.bin'), false),
    ).resolves.toBeUndefined()
  })

  it('throws invalid_output_path for a relative path', async () => {
    await expect(validateOutputPath('relative.bin', false)).rejects.toMatchObject({
      name: 'OutputPathError',
      code: 'invalid_output_path',
    })
  })

  it('throws output_exists when the file already exists and overwrite=false', async () => {
    const path = join(tempDir, 'already.bin')
    await writeFile(path, 'x')
    await expect(validateOutputPath(path, false)).rejects.toMatchObject({
      name: 'OutputPathError',
      code: 'output_exists',
    })
  })

  it('does not throw when the file exists but overwrite=true', async () => {
    const path = join(tempDir, 'already.bin')
    await writeFile(path, 'x')
    await expect(validateOutputPath(path, true)).resolves.toBeUndefined()
  })

  describe('allowedDir confinement', () => {
    it('accepts a path inside allowedDir', async () => {
      await expect(
        validateOutputPath(join(tempDir, 'sub', 'out.png'), false, tempDir),
      ).resolves.toBeUndefined()
    })

    it('rejects a path outside allowedDir with invalid_output_path', async () => {
      await expect(
        validateOutputPath('/tmp/attack.png', false, tempDir),
      ).rejects.toMatchObject({ name: 'OutputPathError', code: 'invalid_output_path' })
    })

    it('rejects a path that escapes allowedDir via traversal with invalid_output_path', async () => {
      await expect(
        validateOutputPath(join(tempDir, '..', 'escape.png'), false, tempDir),
      ).rejects.toMatchObject({ name: 'OutputPathError', code: 'invalid_output_path' })
    })

    it('rejects a path with control characters', async () => {
      await expect(
        validateOutputPath(join(tempDir, 'bad\x00.png'), false, tempDir),
      ).rejects.toMatchObject({ name: 'OutputPathError', code: 'invalid_output_path' })
    })

    it('still rejects relative paths even when allowedDir is set', async () => {
      await expect(
        validateOutputPath('relative.png', false, tempDir),
      ).rejects.toMatchObject({ name: 'OutputPathError', code: 'invalid_output_path' })
    })
  })

  it('treats only ENOENT as "missing" and propagates other stat errors', async () => {
    // Earlier this test used chmod 0o000 on a real dir to coax EACCES out of
    // stat(). That works on POSIX as a non-root user but no-ops under root
    // (containers, sudo, some CI sandboxes) and is skipped entirely on
    // Windows. Spying on stat reproduces the contract — "any stat error other
    // than ENOENT must surface, not get masked as 'file does not exist'" —
    // on every platform without depending on kernel permission semantics.
    const probe = join(tempDir, 'locked', 'probe.bin')
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    vi.mocked(fsp.stat).mockRejectedValueOnce(eacces)
    await expect(validateOutputPath(probe, false)).rejects.toBe(eacces)
    // It must NOT be normalised into the friendly output_exists /
    // invalid_output_path error; the caller relies on the raw errno to
    // distinguish "permission problem on the destination" from a benign
    // "file is missing".
    expect(eacces).not.toBeInstanceOf(OutputPathError)
  })
})
