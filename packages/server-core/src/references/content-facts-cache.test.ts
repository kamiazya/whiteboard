import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import { ContentFactsCache } from './content-facts-cache.js'

const WS = 'ws-1'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}

async function seedTwo(deps: ReturnType<typeof makeDeps>) {
  const create = (path: string, name?: string) =>
    wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind: 'markdown',
      createWorkspace: true,
      ...(name === undefined ? {} : { name }),
    })
  const a = await create('a', 'Alpha')
  const b = await create('b', 'Beta')
  const set = createDocumentSetTool(deps)
  const write = (documentId: string, body: string) =>
    set.execute({ workspaceId: WS, documentId, markdown: `---\ntype: note\n---\n${body}` })
  await write(a.documentId, 'alpha body one')
  await write(b.documentId, 'beta body one')
  return { a, b, write }
}

describe('ContentFactsCache', () => {
  it('loads every document once, then nothing while frontiers stand still', async () => {
    const deps = makeDeps()
    await seedTwo(deps)
    const loads = vi.spyOn(deps.documentStore, 'loadSnapshot')
    const cache = new ContentFactsCache()

    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const first = await cache.factsFor(deps, entries)
    expect(first.size).toBe(2)
    expect(loads).toHaveBeenCalledTimes(2)

    loads.mockClear()
    const second = await cache.factsFor(deps, entries)
    expect(second.get(entries[0]?.documentId ?? '')?.texts[0]).toContain('alpha body one')
    expect(loads).not.toHaveBeenCalled()
  })

  it('reloads exactly the edited document', async () => {
    const deps = makeDeps()
    const { b, write } = await seedTwo(deps)
    const cache = new ContentFactsCache()
    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })
    await cache.factsFor(deps, entries)

    await write(b.documentId, 'beta body two')
    const loads = vi.spyOn(deps.documentStore, 'loadSnapshot')
    const facts = await cache.factsFor(deps, entries)
    expect(loads).toHaveBeenCalledTimes(1)
    expect(facts.get(b.documentId)?.texts[0]).toContain('beta body two')
  })

  it('evicts a vanished document and serves never-written ones as empty facts without loading', async () => {
    const deps = makeDeps()
    const { a } = await seedTwo(deps)
    // Index row without any snapshot: wb_document_create seeds content, so
    // the frontier-null state is reached through the index directly — the
    // shape a pre-seed-era document still has.
    const empty = await deps.documentIndex.createDocument({
      workspaceId: WS,
      path: 'empty',
      kind: 'markdown',
    })
    const cache = new ContentFactsCache()
    const loads = vi.spyOn(deps.documentStore, 'loadSnapshot')
    const all = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const facts = await cache.factsFor(deps, all)
    expect(facts.get(empty.documentId)).toEqual({ refs: [], texts: [], tags: undefined })
    // Two seeded documents loaded; the snapshotless one never was.
    expect(loads).toHaveBeenCalledTimes(2)

    await deps.documentIndex.deleteDocument({ workspaceId: WS, path: 'a' })
    const after = await cache.factsFor(
      deps,
      await deps.documentIndex.listDocuments({ workspaceId: WS }),
    )
    expect(after.has(a.documentId)).toBe(false)
  })

  it('carries content tags for the tags projection', async () => {
    const deps = makeDeps()
    const doc = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'tagged',
      kind: 'markdown',
      createWorkspace: true,
    })
    await createDocumentSetTool(deps).execute({
      workspaceId: WS,
      documentId: doc.documentId,
      markdown: '---\ntype: note\ntags:\n  - release\n---\nbody',
    })
    const cache = new ContentFactsCache()
    const facts = await cache.factsFor(
      deps,
      await deps.documentIndex.listDocuments({ workspaceId: WS }),
    )
    expect(facts.get(doc.documentId)?.tags).toEqual(['release'])
  })
})
