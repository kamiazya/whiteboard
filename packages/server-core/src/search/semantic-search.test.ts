import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { createDocumentSearchTool } from '../tools/document-search.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import type { Embedder } from './embedder.js'

const WS = 'sem'

function makeDeps(): ServerDeps {
  return makeTestDeps()
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
    id: 'fake@v1',
    dimensions: 3,
    calls: 0,
    async embed(texts: readonly string[], _role: 'query' | 'document') {
      impl.calls += texts.length
      return texts.map(fakeVector)
    },
  }
  return impl
}

async function seed(deps: ReturnType<typeof makeDeps>) {
  // The workspace exists because this fixture says so, not as a side effect
  // of the first create: creating one is ADR-0019's MINT boundary, which
  // keys it by a fresh ULID and would leave the literal below naming nothing.
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const set = createDocumentSetTool(deps)
  const write = async (path: string, name: string, body: string) => {
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind: 'markdown',
      name,
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
    const tool = createDocumentSearchTool({ ...deps, embedder })
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
    const fused = await createDocumentSearchTool({ ...deps, embedder: fakeEmbedder() }).execute({
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
    const out = await createDocumentSearchTool({ ...deps, embedder: fakeEmbedder() }).execute({
      workspaceId: WS,
      query: '初回',
    })
    expect(out.results.map((r) => r.documentId)).toContain(bare.documentId)
  })

  it('reports the lexical rank, 1-based, with no semantic rank when there is no embedder', async () => {
    const deps = makeDeps()
    const { storage } = await seed(deps)
    const out = await createDocumentSearchTool(deps).execute({ workspaceId: WS, query: 'quota' })
    expect(out.results[0]?.documentId).toBe(storage)
    expect(out.results[0]?.lexicalRank).toBe(1)
    // 0 would be falsy, so `if (hit.lexicalRank)` would read the top hit as
    // no hit at all. There is no rank 0.
    expect(out.results.every((r) => (r.lexicalRank ?? 1) >= 1)).toBe(true)
    expect(out.results.every((r) => r.semanticRank === undefined)).toBe(true)
  })

  it('leaves the lexical rank undefined for a document only meaning could find', async () => {
    const deps = makeDeps()
    const { reconnect } = await seed(deps)
    const out = await createDocumentSearchTool({ ...deps, embedder: fakeEmbedder() }).execute({
      workspaceId: WS,
      query: '復旧',
    })
    const hit = out.results.find((r) => r.documentId === reconnect)
    // `復旧` shares no token with the English body, so BM25 never scored it:
    // undefined is what tells a caller there is no match to highlight.
    expect(hit?.lexicalRank).toBeUndefined()
    expect(hit?.semanticRank).toBeGreaterThanOrEqual(1)
  })

  it('ranks against the WHOLE ranking, not the page the caller asked for', async () => {
    const deps = makeDeps()
    const { write } = await seed(deps)
    // `zzz` is a term the fake embedder has never heard of, so it is a pure
    // LEXICAL signal; `初回` is a pure SEMANTIC one. That separation is what
    // lets the two rankings disagree on purpose.
    await write('untitled-5', 'lexical only', 'zzz zzz zzz zzz zzz')
    await write('untitled-6', 'both', 'zzz onboarding')
    await write('untitled-7', 'partial a', 'onboarding 容量')
    await write('untitled-8', 'partial b', 'onboarding socket')

    const out = await createDocumentSearchTool({ ...deps, embedder: fakeEmbedder() }).execute({
      workspaceId: WS,
      query: 'zzz 初回',
      limit: 1,
    })

    // One result asked for, and the winner is the document the two rankings
    // AGREE on rather than the one keywords alone would put first — so its
    // lexical rank is 2 while its position on this page is 1.
    expect(out.results).toHaveLength(1)
    expect(out.results[0]?.name).toBe('both')
    expect(out.results[0]?.lexicalRank).toBe(2)
    expect(out.results[0]?.semanticRank).toBe(1)
  })

  it('breaks a fused tie on evidence, not on which document was created first', async () => {
    // RRF collides BY CONSTRUCTION: 1/(K+1) + 1/(K+2) is exactly
    // 1/(K+2) + 1/(K+1). Of the 400 rank pairs up to 20th place, only 210
    // distinct fused scores exist and 190 of them are shared — ties are the
    // norm here, not an edge case.
    //
    // What broke them was `documentId.localeCompare`, and a document id is
    // `encodeTime(Date.now()) + encodeRandom()`: creation order, with chance
    // deciding inside a millisecond. So the answer to "which of these two
    // equally-ranked documents comes first" was when they happened to be
    // written, which is not a fact about the query.
    const deps = makeDeps()
    // The workspace exists because this fixture says so, not as a side effect
    // of the first create: creating one is ADR-0019's MINT boundary, which
    // keys it by a fresh ULID and would leave the literal below naming nothing.
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const set = createDocumentSetTool(deps)
    const write = async (path: string, name: string, body: string) => {
      const created = await wbDocumentCreate(deps, {
        workspaceId: WS,
        path,
        kind: 'markdown',
        name,
      })
      await set.execute({
        workspaceId: WS,
        documentId: created.documentId,
        markdown: `---\ntype: note\n---\n${body}`,
      })
    }
    // `meaning` is written FIRST, so it holds the lower id and would win a
    // tie decided by id. `keyword` matches the query's own word better, so
    // it should win a tie decided by evidence.
    await write('untitled-1', 'meaning', 'zzz onboarding') // lexical 2, semantic 1
    await write('untitled-2', 'keyword', 'zzz zzz zzz') //    lexical 1, semantic 2

    const out = await createDocumentSearchTool({ ...deps, embedder: fakeEmbedder() }).execute({
      workspaceId: WS,
      query: 'zzz 初回',
      limit: 2,
    })
    expect(out.results.map((r) => r.name)).toEqual(['keyword', 'meaning'])
    expect(out.results[0]?.score).toBeCloseTo(out.results[1]?.score ?? 0, 12)
  })

  it('an embedder that throws degrades to lexical-only', async () => {
    const deps = makeDeps()
    const { storage } = await seed(deps)
    const broken: Embedder = {
      id: 'broken@v1',
      dimensions: 3,
      embed: () => Promise.reject(new Error('model unavailable')),
    }
    const out = await createDocumentSearchTool({ ...deps, embedder: broken }).execute({
      workspaceId: WS,
      query: 'quota',
    })
    expect(out.results.map((r) => r.documentId)).toEqual([storage])
  })

  it('embeds each document once and re-embeds only what changed', async () => {
    const deps = makeDeps()
    const { storage } = await seed(deps)
    const embedder = fakeEmbedder()
    const tool = createDocumentSearchTool({ ...deps, embedder })
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
