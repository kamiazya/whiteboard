import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'

// Replace DATA_DIR with a temporary directory.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const {
  FileCheckpointStore,
  MemoryCheckpointStore,
  validateCheckpointId,
  CHECKPOINTS_DIRNAME,
  cleanupCheckpointFiles,
  listCheckpointPruneCandidates,
} = await import('./checkpoint-store.js')

function docWithElement(id: string): LoroDoc {
  const doc = new LoroDoc()
  const elements = doc.getMovableList('elements') as LoroList
  const el = elements.pushContainer(new LoroMap())
  el.set('id', id)
  el.set('type', 'rectangle')
  el.set('x', 100)
  el.set('y', 200)
  doc.commit()
  return doc
}

describe('validateCheckpointId', () => {
  it('allows alphanumeric characters, hyphens, and underscores', () => {
    expect(() => validateCheckpointId('abc')).not.toThrow()
    expect(() => validateCheckpointId('abc123')).not.toThrow()
    expect(() => validateCheckpointId('a-b_c')).not.toThrow()
    expect(() => validateCheckpointId('ABC-def_123')).not.toThrow()
  })

  it('rejects path traversal attempts', () => {
    expect(() => validateCheckpointId('../escape')).toThrow(/Invalid checkpoint id/)
    expect(() => validateCheckpointId('foo/bar')).toThrow(/Invalid checkpoint id/)
    expect(() => validateCheckpointId('foo.bar')).toThrow(/Invalid checkpoint id/)
  })

  it('rejects empty strings and ids longer than 64 characters', () => {
    expect(() => validateCheckpointId('')).toThrow(/Invalid checkpoint id/)
    expect(() => validateCheckpointId('x'.repeat(65))).toThrow(/64 character limit/)
  })
})

describe('FileCheckpointStore', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-checkpoint-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('restores LoroDoc contents through save -> load', async () => {
    const store = new FileCheckpointStore()
    const doc = docWithElement('elem-1')
    await store.save('cp-one', doc)

    const restored = await store.load('cp-one')
    expect(restored).not.toBeNull()
    const elements = restored!.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    expect(elements).toHaveLength(1)
    expect(elements[0]).toMatchObject({ id: 'elem-1', type: 'rectangle', x: 100, y: 200 })
  })

  it('writes files under DATA_DIR/.checkpoints/', async () => {
    const store = new FileCheckpointStore()
    await store.save('placement', docWithElement('e'))
    const files = await readdir(join(tempDir, CHECKPOINTS_DIRNAME))
    expect(files).toContain('placement.loro')
  })

  it('returns null when loading a missing id', async () => {
    const store = new FileCheckpointStore()
    const restored = await store.load('does-not-exist')
    expect(restored).toBeNull()
  })

  it('returns a corruption error for malformed snapshots', async () => {
    const store = new FileCheckpointStore()
    const dir = join(tempDir, CHECKPOINTS_DIRNAME)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.loro'), new Uint8Array([1, 2, 3, 4]))

    await expect(store.load('broken')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken.loro'),
    })
  })

  it('allows overwrite when saving the same id again', async () => {
    const store = new FileCheckpointStore()
    await store.save('same', docWithElement('first'))
    await store.save('same', docWithElement('second'))
    const restored = await store.load('same')
    const elements = restored!.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    expect(elements[0]).toMatchObject({ id: 'second' })
  })

  it('rejects saves larger than 5 MiB', async () => {
    const store = new FileCheckpointStore()
    // Loro compresses repeated strings heavily, so use random text to approximate an uncompressed payload.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements') as LoroList
    const chunk = 8_000
    const count = 800 // 8000 * 800 ~= 6.4 MiB, still above 5 MiB after snapshotting.
    for (let i = 0; i < count; i++) {
      let s = ''
      for (let k = 0; k < chunk; k++) s += String.fromCharCode(32 + Math.floor(Math.random() * 90))
      const m = list.pushContainer(new LoroMap())
      m.set('id', `e-${i}`)
      m.set('payload', s)
    }
    doc.commit()
    await expect(store.save('too-big', doc)).rejects.toThrow(/exceeds/)
  })

  it('rejects invalid ids for both save and load', async () => {
    const store = new FileCheckpointStore()
    await expect(store.save('../escape', docWithElement('x'))).rejects.toThrow(/Invalid checkpoint id/)
    await expect(store.load('../escape')).rejects.toThrow(/Invalid checkpoint id/)
  })

  it('lists saved ids in descending updatedAt order', async () => {
    const store = new FileCheckpointStore()
    await store.save('first', docWithElement('a'))
    // Wait 10 ms to ensure mtime changes.
    await new Promise((r) => setTimeout(r, 10))
    await store.save('second', docWithElement('b'))
    const list = await store.list()
    expect(list.map((e) => e.id)).toEqual(['second', 'first'])
    expect(list[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('does not collapse broken directory entries into an empty list', async () => {
    const store = new FileCheckpointStore()
    const dir = join(tempDir, CHECKPOINTS_DIRNAME)
    await mkdir(join(dir, 'broken-entry.loro'), { recursive: true })

    await expect(store.list()).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken-entry.loro'),
    })
  })

  it('surfaces broken checkpoint directory layouts in listCheckpointPruneCandidates', async () => {
    await writeFile(join(tempDir, CHECKPOINTS_DIRNAME), 'not-a-directory')

    await expect(
      listCheckpointPruneCandidates(join(tempDir, CHECKPOINTS_DIRNAME)),
    ).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining(CHECKPOINTS_DIRNAME),
    })
  })

  it('does not silently treat stat failures as success in listCheckpointPruneCandidates', async () => {
    const dir = join(tempDir, CHECKPOINTS_DIRNAME)
    await mkdir(join(dir, 'broken-entry.loro'), { recursive: true })

    await expect(listCheckpointPruneCandidates(dir)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('broken-entry.loro'),
    })
  })

  it('treats only missing files as no-op in cleanupCheckpointFiles and returns unlink failures', async () => {
    const dir = join(tempDir, CHECKPOINTS_DIRNAME)
    await mkdir(dir, { recursive: true })
    await mkdir(join(dir, 'stuck.loro'), { recursive: true })

    const errors = await cleanupCheckpointFiles(dir, ['missing.loro', 'stuck.loro'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining('stuck.loro'),
    })
  })
})

describe('MemoryCheckpointStore', () => {
  it('restores content through save -> load', async () => {
    const store = new MemoryCheckpointStore()
    await store.save('mem-1', docWithElement('m'))
    const restored = await store.load('mem-1')
    const elements = restored!.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    expect(elements[0]).toMatchObject({ id: 'm' })
  })

  it('returns null for missing ids', async () => {
    const store = new MemoryCheckpointStore()
    expect(await store.load('nope')).toBeNull()
  })

  it('uses the same id validation rules', async () => {
    const store = new MemoryCheckpointStore()
    await expect(store.save('bad/id', docWithElement('x'))).rejects.toThrow(/Invalid checkpoint id/)
  })
})
