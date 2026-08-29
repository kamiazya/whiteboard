import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PENDING_WRITES_DIRNAME, writeFileAtomic } from './atomic-write.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-atomic-write-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('never lets a reader see the target half-written', async () => {
    const target = join(dir, 'thing.bin')
    // Large enough that the write spans many reads. A small payload can
    // finish inside one scheduler turn and hide the window entirely.
    const bytes = new Uint8Array(6 * 1024 * 1024).fill(0x41)
    await writeFileAtomic(dir, target, bytes)

    const reads: Array<Promise<number>> = []
    const rewriting = writeFileAtomic(dir, target, bytes)
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
    await writeFileAtomic(dir, join(targetDir, 'a.png'), new Uint8Array(64))

    expect(await readdir(targetDir)).toEqual(['a.png'])
    expect(await readdir(join(dir, PENDING_WRITES_DIRNAME))).toEqual([])
  })

  it('leaves nothing staged when the rename cannot land', async () => {
    // A target whose parent does not exist: the write succeeds, the rename
    // fails, and the staged bytes must not survive it.
    await expect(
      writeFileAtomic(dir, join(dir, 'no', 'such', 'dir', 'x.bin'), new Uint8Array(8)),
    ).rejects.toThrow()
    expect(await readdir(join(dir, PENDING_WRITES_DIRNAME))).toEqual([])
  })
})
