import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OutputPathError, validateOutputPath } from './output-path.js'

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
    // Make a directory unreadable, then probe a path inside it. stat() should
    // fail with EACCES rather than ENOENT, and validateOutputPath must
    // surface that instead of pretending the file is absent.
    if (process.platform === 'win32') {
      // Skipping: posix permission semantics are not portable to Windows.
      return
    }
    const lockedDir = join(tempDir, 'locked')
    await mkdir(lockedDir)
    const probe = join(lockedDir, 'probe.bin')
    await chmod(lockedDir, 0o000)
    try {
      await expect(validateOutputPath(probe, false)).rejects.toThrow()
      // The thrown error must NOT be the friendly OutputPathError for
      // output_exists / invalid_output_path; it should be the underlying
      // EACCES so the caller is not silently stepped over.
      await validateOutputPath(probe, false).catch((err) => {
        expect(err).not.toBeInstanceOf(OutputPathError)
      })
    } finally {
      await chmod(lockedDir, 0o755)
    }
  })
})
