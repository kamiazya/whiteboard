import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCheckpointScheduler } from './scheduler.js'

function edited(doc: LoroDoc, key: string): LoroDoc {
  doc.getMap('nodes').set(key, 1)
  doc.commit()
  return doc
}

describe('createCheckpointScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function harness(opts: { quietMs?: number; ceilingMs?: number } = {}) {
    const saves: Array<{ path: string; branchName: string | null }> = []
    const errors: unknown[] = []
    const scheduler = createCheckpointScheduler<{ id: string }>({
      ...opts,
      save: async (_ws, path, _doc, branchName) => {
        saves.push({ path, branchName })
        return { id: `v${saves.length}` }
      },
      getHeadBranch: async () => 'idea',
      onError: (err) => errors.push(err),
    })
    return { scheduler, saves, errors }
  }

  it('takes one checkpoint once the document has been quiet, carrying the head branch', async () => {
    const { scheduler, saves } = harness({ quietMs: 1000 })
    const doc = new LoroDoc()
    scheduler('w', 'a', edited(doc, 'x'))
    await vi.advanceTimersByTimeAsync(600)
    scheduler('w', 'a', edited(doc, 'y'))
    await vi.advanceTimersByTimeAsync(600)
    expect(saves).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(saves).toEqual([{ path: 'a', branchName: 'idea' }])
  })

  it('writes no row for a document whose frontier has not moved since its last checkpoint', async () => {
    const { scheduler, saves } = harness({ quietMs: 100 })
    const doc = edited(new LoroDoc(), 'x')
    scheduler('w', 'a', doc)
    await vi.advanceTimersByTimeAsync(150)
    scheduler('w', 'a', doc)
    await vi.advanceTimersByTimeAsync(150)
    expect(saves).toHaveLength(1)
  })

  it('takes a checkpoint at the ceiling when editing never pauses', async () => {
    const { scheduler, saves } = harness({ quietMs: 1000, ceilingMs: 2500 })
    const doc = new LoroDoc()
    for (let i = 0; i < 6; i++) {
      scheduler('w', 'a', edited(doc, `k${i}`))
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(saves).toHaveLength(1)
  })

  it('flush takes every pending checkpoint now; stop drops them', async () => {
    const { scheduler, saves } = harness({ quietMs: 60_000 })
    scheduler('w', 'a', edited(new LoroDoc(), 'x'))
    scheduler('w', 'b', edited(new LoroDoc(), 'y'))
    await scheduler.flush()
    expect(saves.map((s) => s.path).sort()).toEqual(['a', 'b'])

    scheduler('w', 'c', edited(new LoroDoc(), 'z'))
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(saves.map((s) => s.path)).not.toContain('c')
  })

  it('reports a failed save and leaves the next edit free to try again', async () => {
    let fail = true
    const saves: string[] = []
    const errors: unknown[] = []
    const scheduler = createCheckpointScheduler<void>({
      quietMs: 100,
      save: async (_ws, path) => {
        if (fail) throw new Error('disk full')
        saves.push(path)
      },
      onError: (err) => errors.push(err),
    })
    const doc = edited(new LoroDoc(), 'x')
    scheduler('w', 'a', doc)
    await vi.advanceTimersByTimeAsync(150)
    expect(errors).toHaveLength(1)
    fail = false
    scheduler('w', 'a', doc)
    await vi.advanceTimersByTimeAsync(150)
    expect(saves).toEqual(['a'])
  })

  it('absorbs an ordinary head-lookup failure as no branch, and rethrows a fatal one', async () => {
    const saves: Array<string | null> = []
    const errors: unknown[] = []
    let fatal = false
    const scheduler = createCheckpointScheduler<void>({
      quietMs: 100,
      save: async (_ws, _path, _doc, branchName) => {
        saves.push(branchName)
      },
      getHeadBranch: async () => {
        throw new Error(fatal ? 'corrupt' : 'transient')
      },
      isFatal: (err) => (err as Error).message === 'corrupt',
      onError: (err) => errors.push(err),
    })
    scheduler('w', 'a', edited(new LoroDoc(), 'x'))
    await vi.advanceTimersByTimeAsync(150)
    expect(saves).toEqual([null])
    fatal = true
    scheduler('w', 'b', edited(new LoroDoc(), 'y'))
    await vi.advanceTimersByTimeAsync(150)
    expect(saves).toEqual([null])
    expect(errors).toHaveLength(1)
  })
})
