import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-auto-version-timing-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createAutoVersionTrigger } = await import('./auto-version.js')
type VersionStore = import('../../store/version-store.js').VersionStore

/**
 * WHEN a checkpoint is taken.
 *
 * The trigger used to be a leading-edge throttle: it fired on the first
 * update after the interval had elapsed, which put every checkpoint in the
 * MIDDLE of an editing burst and — because it only runs when an update
 * arrives — could never take one after editing stopped. Measured at a 200ms
 * interval: edits at 0/60/…/670ms produced saves at 0/240/490ms and nothing
 * in the 600ms that followed the last edit. The state a person leaves behind
 * was the one state no checkpoint held.
 *
 * It is now a trailing debounce: a checkpoint lands once the document has
 * been quiet, which is both where the cost is free and where the row is
 * worth listing.
 */

function fakeStore(saves: string[]): VersionStore {
  return {
    save: async (_workspaceId: string, path: string) => {
      saves.push(path)
      return { id: `v${saves.length}` }
    },
  } as unknown as VersionStore
}

function editableDoc(): LoroDoc {
  const doc = new LoroDoc()
  doc.getMap('m').set('k', 0)
  doc.commit()
  return doc
}

function edit(doc: LoroDoc, n: number): void {
  doc.getMap('m').set('k', n)
  doc.commit()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  vi.useRealTimers()
})

describe('a checkpoint is taken when the document goes quiet', () => {
  it('takes exactly one checkpoint after a burst of edits, and takes it after the burst', async () => {
    const saves: string[] = []
    const trigger = createAutoVersionTrigger(fakeStore(saves), {
      quietMs: 120,
      ceilingMs: 60_000,
    })
    const doc = editableDoc()

    for (let i = 0; i < 8; i++) {
      edit(doc, i)
      trigger('ws', 'doc', doc)
      await sleep(30)
    }
    // Still editing: nothing has landed yet.
    expect(saves).toEqual([])

    await sleep(300)
    expect(saves).toEqual(['doc'])
    trigger.stop()
  })

  it('does nothing when the document has not changed since its last checkpoint', async () => {
    const saves: string[] = []
    const trigger = createAutoVersionTrigger(fakeStore(saves), {
      quietMs: 60,
      ceilingMs: 60_000,
    })
    const doc = editableDoc()

    edit(doc, 1)
    trigger('ws', 'doc', doc)
    await sleep(200)
    expect(saves).toEqual(['doc'])

    // A signal with no edit behind it — a save that reports the same state
    // twice is a row nobody can tell from its neighbour.
    trigger('ws', 'doc', doc)
    await sleep(200)
    expect(saves).toEqual(['doc'])
    trigger.stop()
  })

  it('takes one anyway when editing never pauses, so a long session is not left uncovered', async () => {
    const saves: string[] = []
    const trigger = createAutoVersionTrigger(fakeStore(saves), {
      quietMs: 10_000,
      ceilingMs: 150,
    })
    const doc = editableDoc()

    for (let i = 0; i < 12; i++) {
      edit(doc, i)
      trigger('ws', 'doc', doc)
      await sleep(30)
    }
    expect(saves.length).toBeGreaterThanOrEqual(1)
    trigger.stop()
  })

  it('flushes a pending checkpoint on demand, for the moment a session ends', async () => {
    const saves: string[] = []
    const trigger = createAutoVersionTrigger(fakeStore(saves), {
      quietMs: 60_000,
      ceilingMs: 60_000,
    })
    const doc = editableDoc()

    edit(doc, 1)
    trigger('ws', 'doc', doc)
    expect(saves).toEqual([])

    await trigger.flush()
    expect(saves).toEqual(['doc'])
    trigger.stop()
  })

  it('reports the checkpoint to onSaved, which is what broadcasts it', async () => {
    const saves: string[] = []
    const seen: string[] = []
    const trigger = createAutoVersionTrigger(fakeStore(saves), {
      quietMs: 40,
      ceilingMs: 60_000,
      onSaved: (workspaceId, path, entry) => seen.push(`${workspaceId}/${path}:${entry.id}`),
    })
    const doc = editableDoc()

    edit(doc, 1)
    trigger('ws', 'doc', doc)
    await sleep(200)
    expect(seen).toEqual(['ws/doc:v1'])
    trigger.stop()
  })
})
