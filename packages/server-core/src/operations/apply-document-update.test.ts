import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments } from '../server-deps.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'

const WS = 'ws-1'
const PATH = 'canvas-a'

function updateBytes(nodeIds: readonly string[]): Uint8Array {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => ({
      id,
      type: 'text' as const,
      text: id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })),
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array
}

/**
 * Spread over the REFUSING defaults so any call the operation makes beyond
 * get/save/evict/withWriteLock fails loudly instead of passing silently.
 * Lock depth is recorded per call — the property is not only "the right
 * calls happen" but "none of them happens outside the one lock hold" (the
 * rename race the route's own comment documents).
 */
function fakeLive(initial?: LoroDoc) {
  const calls: { method: string; lockDepth: number; overwrite?: boolean }[] = []
  const evicted: string[] = []
  let lockDepth = 0
  let stored = initial ?? null
  let saved: LoroDoc | null = null
  let failNextSave: Error | null = null
  const live: LiveDocuments = {
    ...unusedLiveDocuments(),
    async get(_workspaceId, _path) {
      calls.push({ method: 'get', lockDepth })
      if (stored === null) stored = new LoroDoc()
      return stored
    },
    async save(_workspaceId, _path, doc, options) {
      calls.push({ method: 'save', lockDepth, overwrite: options?.overwrite ?? false })
      if (failNextSave !== null) {
        const err = failNextSave
        failNextSave = null
        throw err
      }
      saved = doc
    },
    evict(_workspaceId, path) {
      calls.push({ method: 'evict', lockDepth })
      evicted.push(path)
    },
    async withWriteLock<T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> {
      lockDepth += 1
      try {
        return await fn()
      } finally {
        lockDepth -= 1
      }
    },
  }
  return {
    live,
    calls,
    evicted,
    savedDoc: () => saved,
    failNextSave: (err: Error) => {
      failNextSave = err
    },
  }
}

describe('applyDocumentUpdate', () => {
  it('imports the update into the live doc, saves with overwrite, and returns the SAME instance', async () => {
    const existing = new LoroDoc()
    const fake = fakeLive(existing)
    const returned = await applyDocumentUpdate(
      { liveDocuments: fake.live },
      { workspaceId: WS, path: PATH, update: updateBytes(['n1', 'n2']) },
    )
    expect(returned).toBe(existing)
    expect(fake.savedDoc()).toBe(existing)
    expect(
      readSpatialCanvas(existing)
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['n1', 'n2'])
    expect(fake.calls.find((c) => c.method === 'save')).toMatchObject({ overwrite: true })
    for (const call of fake.calls) {
      expect(call, `${call.method} ran outside the workspace write lock`).toMatchObject({
        lockDepth: 1,
      })
    }
  })

  it('an unknown path lazy-creates rather than refusing (the WS/update-on-unknown-path behavior)', async () => {
    const fake = fakeLive()
    const returned = await applyDocumentUpdate(
      { liveDocuments: fake.live },
      { workspaceId: WS, path: PATH, update: updateBytes(['n1']) },
    )
    expect(readSpatialCanvas(returned).nodes.map((n) => n.id)).toEqual(['n1'])
    expect(fake.savedDoc()).toBe(returned)
  })

  it('evicts the live doc when the save fails, then rethrows', async () => {
    const fake = fakeLive(new LoroDoc())
    fake.failNextSave(new Error('disk full'))
    await expect(
      applyDocumentUpdate(
        { liveDocuments: fake.live },
        { workspaceId: WS, path: PATH, update: updateBytes(['n1']) },
      ),
    ).rejects.toThrow('disk full')
    expect(fake.evicted).toEqual([PATH])
    for (const call of fake.calls) {
      expect(call, `${call.method} ran outside the workspace write lock`).toMatchObject({
        lockDepth: 1,
      })
    }
  })
})
