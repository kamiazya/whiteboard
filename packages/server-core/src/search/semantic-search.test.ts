import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { createDocumentSearchTool } from '../tools/document-search.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import type { Embedder } from './embedder.js'

const WS = 'sem'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}

/**
 * A deterministic stand-in for a model: it maps a handful of CONCEPTS to
 * orthogonal unit vectors, so "the same idea in other words" lands on the
 * same axis with no shared token. No download, no network — the point
 * under test is fusion and caching, not any particular model's quality.
 */
const CONCEPTS: Record<string, number> = { reconnect: 0, storage: 1, onboarding: 2 }
const VOCAB: Record<string, string> = {
  再接続: 'reconnect',
  reconnect: 'reconnect',
  復旧: 'reconnect',
  socket: 'reconnect',
  容量: 'storage',
  quota: 'storage',
  storage: 'storage',
  見積: 'storage',
  onboarding: 'onboarding',
  初回: 'onboarding',
}
function fakeVector(text: string): Float32Array {
  const v = new Float32Array(3)
  for (const [word, concept] of Object.entries(VOCAB)) {
    if (text.includes(word)) v[CONCEPTS[concept] as number] = 1
  }
  const norm = Math.hypot(...v)
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm
  return v
}
function fakeEmbedder(): Embedder & { calls: number } {
  const impl = {
    dimensions: 3,
    calls: 0,
    async embed(texts: readonly string[]) {
      impl.calls += texts.length
      return texts.map(fakeVector)
    },
  }
  return impl
}

async function seed(deps: ReturnType<typeof makeDeps>) {
  const set = createDocumentSetTool(deps)
  const write = async (path: string, name: string, body: string) => {
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind: 'markdown',
      name,
      createWorkspace: true,
    })
    await set.execute({
      workspaceId: WS,
      documentId: created.documentId,
      markdown: `---\ntype: note\n---\n${body}`,
    })
    return created.documentId
  }
  return {
    reconnect: await write('untitled-1', '同期', 'socket が切れたら reconnect する'),
    storage: await write('untitled-2', '容量', 'quota を超えると保存に失敗する'),
    write,
  }
}

describe('semantic fusion', () => {
  it('with no embedder, results are stage 0 exactly', async () => {
    const deps = makeDeps()
    const { reconnect } = await seed(deps)
    const out = await createDocumentSearchTool(deps).execute({
      workspaceId: WS,
      query: 'reconnect',
    })
    expect(out.results.map((r) => r.documentId)).toEqual([reconnect])
    // A query with no shared token finds nothing without vectors.
    const miss = await createDocumentSearchTool(deps).execute({ workspaceId: WS, query: '復旧' })
    expect(miss.results).toEqual([])
  })

  it('with an embedder, a query sharing no token with the document is retrieved', async () => {
    const deps = makeDeps()
    const { reconnect } = await seed(deps)
    const embedder = fakeEmbedder()
    const tool = createDocumentSearchTool(deps, undefined, () => embedder)
    const out = await tool.execute({ workspaceId: WS, query: '復旧' })
    expect(out.results.map((r) => r.documentId)).toContain(reconnect)
  })

  it('fusion never loses a lexical hit', async () => {
    const deps = makeDeps()
    const { reconnect, storage } = await seed(deps)
    const lexicalOnly = await createDocumentSearchTool(deps).execute({
      workspaceId: WS,
      query: 'quota',
    })
    expect(lexicalOnly.results.map((r) => r.documentId)).toEqual([storage])
    const fused = await createDocumentSearchTool(deps, undefined, () => fakeEmbedder()).execute({
      workspaceId: WS,
      query: 'quota',
    })
    for (const hit of lexicalOnly.results) {
      expect(fused.results.map((r) => r.documentId)).toContain(hit.documentId)
    }
    void reconnect
  })

  it('a document that is only a name is still embedded', async () => {
    const deps = makeDeps()
    await seed(deps)
    const bare = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'untitled-9',
      kind: 'markdown',
      name: 'onboarding',
    })
    const out = await createDocumentSearchTool(deps, undefined, () => fakeEmbedder()).execute({
      workspaceId: WS,
      query: '初回',
    })
    expect(out.results.map((r) => r.documentId)).toContain(bare.documentId)
  })

  it('an embedder that throws degrades to lexical-only', async () => {
    const deps = makeDeps()
    const { storage } = await seed(deps)
    const broken: Embedder = {
      dimensions: 3,
      embed: () => Promise.reject(new Error('model unavailable')),
    }
    const out = await createDocumentSearchTool(deps, undefined, () => broken).execute({
      workspaceId: WS,
      query: 'quota',
    })
    expect(out.results.map((r) => r.documentId)).toEqual([storage])
  })

  it('embeds each document once and re-embeds only what changed', async () => {
    const deps = makeDeps()
    const { storage } = await seed(deps)
    const embedder = fakeEmbedder()
    const tool = createDocumentSearchTool(deps, undefined, () => embedder)
    await tool.execute({ workspaceId: WS, query: 'quota' })
    const afterFirst = embedder.calls
    expect(afterFirst).toBeGreaterThanOrEqual(2)

    // Unchanged corpus: only the QUERY is embedded on the second run.
    await tool.execute({ workspaceId: WS, query: 'quota' })
    expect(embedder.calls).toBe(afterFirst + 1)

    // One document edited: that document plus the query.
    await createDocumentSetTool(deps).execute({
      workspaceId: WS,
      documentId: storage,
      markdown: '---\ntype: note\n---\nquota まわりを書き直した',
    })
    const before = embedder.calls
    await tool.execute({ workspaceId: WS, query: 'quota' })
    expect(embedder.calls).toBe(before + 2)
  })
})
