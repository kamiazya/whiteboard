import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quarantineLegacyVersionMeta } from './legacy-quarantine.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'legacy-quarantine-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('quarantineLegacyVersionMeta', () => {
  it('renames .json files missing frontiers to .legacy-bak', async () => {
    const versions = join(tempDir, 'sess-a', 'versions')
    await mkdir(versions, { recursive: true })
    await writeFile(
      join(versions, 'old.json'),
      JSON.stringify({ slug: 'c1', createdAt: '2026-01-01T00:00:00Z', elementCount: 1, auto: true }),
    )
    const result = await quarantineLegacyVersionMeta(tempDir)
    expect(result.movedCount).toBe(1)
    const files = await readdir(versions)
    expect(files).toContain('old.json.legacy-bak')
    expect(files).not.toContain('old.json')
  })

  it('leaves metadata with frontiers untouched', async () => {
    const versions = join(tempDir, 'sess-a', 'versions')
    await mkdir(versions, { recursive: true })
    await writeFile(
      join(versions, 'ok.json'),
      JSON.stringify({
        slug: 'c1',
        createdAt: '2026-04-01T00:00:00Z',
        elementCount: 1,
        auto: true,
        frontiers: 'AA==',
        branchName: 'main',
      }),
    )
    const result = await quarantineLegacyVersionMeta(tempDir)
    expect(result.movedCount).toBe(0)
    const files = await readdir(versions)
    expect(files).toEqual(['ok.json'])
  })

  it('also quarantines invalid JSON as legacy', async () => {
    const versions = join(tempDir, 'sess-a', 'versions')
    await mkdir(versions, { recursive: true })
    await writeFile(join(versions, 'broken.json'), '{not-json')
    const result = await quarantineLegacyVersionMeta(tempDir)
    expect(result.movedCount).toBe(1)
    const files = await readdir(versions)
    expect(files).toContain('broken.json.legacy-bak')
  })

  it('processes every matching file across multiple sessions', async () => {
    await mkdir(join(tempDir, 's1', 'versions'), { recursive: true })
    await mkdir(join(tempDir, 's2', 'versions'), { recursive: true })
    await writeFile(
      join(tempDir, 's1', 'versions', 'a.json'),
      JSON.stringify({ slug: 'c', createdAt: 'x', elementCount: 0, auto: true }),
    )
    await writeFile(
      join(tempDir, 's2', 'versions', 'b.json'),
      JSON.stringify({ slug: 'c', createdAt: 'x', elementCount: 0, auto: true }),
    )
    const result = await quarantineLegacyVersionMeta(tempDir)
    expect(result.movedCount).toBe(2)
  })

  it('skips sessions that do not have a versions directory', async () => {
    await mkdir(join(tempDir, 'empty-sess'), { recursive: true })
    const result = await quarantineLegacyVersionMeta(tempDir)
    expect(result.movedCount).toBe(0)
  })

  it('returns immediately with zero results when DATA_DIR itself does not exist', async () => {
    const result = await quarantineLegacyVersionMeta(join(tempDir, 'not-yet-created'))
    expect(result.movedCount).toBe(0)
  })

  it('is idempotent: a second run over the same directory moves zero files', async () => {
    const versions = join(tempDir, 's1', 'versions')
    await mkdir(versions, { recursive: true })
    await writeFile(
      join(versions, 'old.json'),
      JSON.stringify({ slug: 'c', createdAt: 'x', elementCount: 0, auto: true }),
    )
    const first = await quarantineLegacyVersionMeta(tempDir)
    const second = await quarantineLegacyVersionMeta(tempDir)
    expect(first.movedCount).toBe(1)
    expect(second.movedCount).toBe(0)
  })

  it('ignores non-.json and already-renamed .json.legacy-bak files', async () => {
    const versions = join(tempDir, 's1', 'versions')
    await mkdir(versions, { recursive: true })
    await writeFile(join(versions, 'ok.png'), Buffer.from([0x89, 0x50]))
    await writeFile(join(versions, 'ok.json.legacy-bak'), 'legacy')
    const result = await quarantineLegacyVersionMeta(tempDir)
    expect(result.movedCount).toBe(0)
  })
})
