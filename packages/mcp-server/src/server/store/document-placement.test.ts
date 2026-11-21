import type { RecordSession } from '@kamiazya/whiteboard-loro-adapter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { placeDocumentInTree } from './document-placement.js'
import { storeScope } from './store-scope.js'
import * as cache from './workspace-doc-cache.js'

type Query = { query: string; args?: unknown }

/** A session that answers the reads a placement makes, and records the writes. */
function session(answers: {
  documents?: unknown[]
  nodes?: unknown[]
  entry?: unknown
  writeThrows?: Error
}) {
  const writes: unknown[][] = []
  const reads: string[] = []
  const fake = {
    read: async (query: Query) => {
      reads.push(query.query)
      if (query.query === 'documents') return answers.documents ?? []
      if (query.query === 'nodes') return answers.nodes ?? []
      return answers.entry ?? { documentId: 'doc' }
    },
    write: (batch: unknown[]) => {
      if (answers.writeThrows !== undefined) throw answers.writeThrows
      writes.push(batch)
    },
  } as unknown as RecordSession
  return { fake, writes, reads }
}

const scope = storeScope('/tmp/placement-test')
const base = {
  workspaceId: 'ws',
  documentId: 'doc',
  path: 'a/b',
  requestedKind: undefined,
  statedKind: null,
  snapshot: new Uint8Array([1, 2, 3]),
  scope,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('placing a document in the tree', () => {
  it('creates the node first, then writes the content, for a path the tree does not hold', async () => {
    const { fake, writes, reads } = session({})

    const placed = await placeDocumentInTree({ ...base, record: fake, existingEntry: null })

    expect(placed).toBe(true)
    expect(reads.slice(0, 2)).toEqual(['documents', 'nodes'])
    expect(writes).toHaveLength(1)
    expect((writes[0] as { op: string }[]).map((step) => step.op)).toEqual([
      'createWorkspaceDocumentAtPath',
      'writeDocumentContentAndName',
    ])
  })

  it("takes the kind a request names, else the tree's, else the content's own, else spatial", async () => {
    const kindOf = async (input: Partial<Parameters<typeof placeDocumentInTree>[0]>) => {
      const { fake, writes } = session({})
      await placeDocumentInTree({ ...base, record: fake, existingEntry: null, ...input })
      return (writes[0] as { args: { kind?: string } }[])[0]?.args.kind
    }
    expect(await kindOf({ requestedKind: 'markdown', statedKind: 'spatial' })).toBe('markdown')
    expect(await kindOf({ statedKind: 'markdown' })).toBe('markdown')
    expect(await kindOf({})).toBe('spatial')
  })

  it('only rewrites the content of a document the tree holds, and its kind when one is asked for', async () => {
    const plain = session({})
    await placeDocumentInTree({
      ...base,
      record: plain.fake,
      existingEntry: { documentId: 'doc', kind: 'markdown' },
    })
    expect((plain.writes[0] as { op: string }[]).map((step) => step.op)).toEqual([
      'writeDocumentContentAndName',
    ])
    expect(plain.reads).not.toContain('documents')

    const retyped = session({})
    await placeDocumentInTree({
      ...base,
      record: retyped.fake,
      requestedKind: 'spatial',
      existingEntry: { documentId: 'doc', kind: 'markdown' },
    })
    expect((retyped.writes[0] as { op: string }[]).map((step) => step.op)).toEqual([
      'updateWorkspaceDocumentMeta',
      'writeDocumentContentAndName',
    ])
  })

  it('answers false for a document the tree no longer holds', async () => {
    const { fake } = session({ entry: null })
    // `answers.entry ?? ...` would turn null into a hit, so the fake is made to answer null itself.
    ;(fake as unknown as { read: unknown }).read = async (query: Query) =>
      query.query === 'workspaceDocumentEntry' ? null : []

    expect(await placeDocumentInTree({ ...base, record: fake, existingEntry: null })).toBe(false)
  })

  it('drops the cached record when a write throws part-way, and rethrows', async () => {
    const evict = vi.spyOn(cache, 'evictWorkspaceDocCache').mockImplementation(() => {})
    const { fake } = session({ writeThrows: new Error('trap') })

    await expect(
      placeDocumentInTree({ ...base, record: fake, existingEntry: null }),
    ).rejects.toThrow('trap')

    expect(evict).toHaveBeenCalledWith('ws', scope)
  })
})
