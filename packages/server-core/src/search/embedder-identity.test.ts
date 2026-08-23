import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { ContentFactsCache } from '../references/content-facts-cache.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import type { Embedder } from './embedder.js'

const WS = 'identity'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}

/** Two embedders that disagree, sharing a width so only `id` separates them. */
function embedderNamed(id: string, fill: number): Embedder & { calls: number } {
  const impl = {
    id,
    dimensions: 3,
    calls: 0,
    async embed(texts: readonly string[], _role: 'query' | 'document') {
      impl.calls += texts.length
      return texts.map(() => Float32Array.from([fill, 0, 0]))
    },
  }
  return impl
}

async function seed(deps: ReturnType<typeof makeDeps>) {
  const created = await wbDocumentCreate(deps, {
    workspaceId: WS,
    path: 'untitled-1',
    kind: 'markdown',
    name: 'note',
    createWorkspace: true,
  })
  await createDocumentSetTool(deps).execute({
    workspaceId: WS,
    documentId: created.documentId,
    markdown: '---\ntype: note\n---\nsome body text',
  })
  return created.documentId
}

describe('a cached vector remembers which embedder made it', () => {
  it('re-embeds when the embedder changes, even though the document did not', async () => {
    const deps = makeDeps()
    await seed(deps)
    const cache = new ContentFactsCache()
    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })

    const q8 = embedderNamed('e5-small@q8', 1)
    const first = await cache.vectorsFor(deps, WS, entries, q8)
    expect(first[0]?.vector[0]).toBe(1)

    // Same documents, different model. Reusing the cached vector would mix
    // two vector spaces: the query embedded by one model, the documents by
    // another. Cosine between them is not a similarity, and nothing errors.
    const fp32 = embedderNamed('e5-small@fp32', 2)
    const second = await cache.vectorsFor(deps, WS, entries, fp32)
    expect(second[0]?.vector[0]).toBe(2)
    expect(fp32.calls).toBeGreaterThan(0)
  })

  it('still caches when the embedder is unchanged', async () => {
    const deps = makeDeps()
    await seed(deps)
    const cache = new ContentFactsCache()
    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })

    const q8 = embedderNamed('e5-small@q8', 1)
    await cache.vectorsFor(deps, WS, entries, q8)
    const after = q8.calls
    await cache.vectorsFor(deps, WS, entries, q8)
    expect(q8.calls).toBe(after)
  })

  it('separates two embedders that share a width, since dimensions cannot', async () => {
    const deps = makeDeps()
    await seed(deps)
    const cache = new ContentFactsCache()
    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const a = embedderNamed('same-width-a', 1)
    const b = embedderNamed('same-width-b', 2)
    expect(a.dimensions).toBe(b.dimensions)
    await cache.vectorsFor(deps, WS, entries, a)
    const out = await cache.vectorsFor(deps, WS, entries, b)
    expect(out[0]?.vector[0]).toBe(2)
  })
})
