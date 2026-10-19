import type { ContentFacts } from '@kamiazya/whiteboard-reference-graph'
import { describe, expect, it } from 'vitest'
import { factsCacheFor } from '../references/content-source.js'
import { vectorCacheFor } from '../search/document-vector-cache.js'
import type { ServerDeps } from '../server-deps.js'
import { fc, withDefaults } from '../test-utils/fast-check.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSearchTool } from './document-search.js'

const WS = 'ws-1'
type Bearer = ContentFacts['bearers'][number]

/**
 * The tool over `deps`, with every fact the cache answers passed through
 * `rewrite` first — the seam both tests read the tag filter through, so it is
 * the real tool, the real listing and the real facts cache all the way down.
 */
function toolOver(
  deps: ServerDeps,
  rewrite: (facts: ContentFacts) => ContentFacts,
): ReturnType<typeof createDocumentSearchTool> {
  const facts = factsCacheFor(deps)
  const factsFor = facts.factsFor.bind(facts)
  facts.factsFor = async (workspaceId, entries) => {
    const real = await factsFor(workspaceId, entries)
    return new Map([...real].map(([id, one]) => [id, rewrite(one)]))
  }
  return createDocumentSearchTool(deps, vectorCacheFor(deps))
}

/** A tags array that counts each element read, however it is read. */
function counted(tags: readonly string[], tally: { reads: number }): readonly string[] {
  return new Proxy([...tags], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) tally.reads += 1
      return Reflect.get(target, key, receiver)
    },
  })
}

async function seededBoard(nodes: number, tagsEach: number) {
  const deps = makeTestDeps()
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const board = await wbDocumentCreate(deps, { workspaceId: WS, path: 'board', kind: 'spatial' })
  const tags = Array.from({ length: tagsEach }, (_, i) => `t${i}`)
  await createCanvasEditTool(deps).execute({
    workspaceId: WS,
    documentId: board.documentId,
    mode: 'apply',
    ops: Array.from({ length: nodes }, (_, i) => ({
      op: 'node.add' as const,
      node: { id: `n${i}`, type: 'text' as const, text: `node ${i}`, tags },
    })),
  })
  return { deps, last: tags[tagsEach - 1] as string }
}

describe('wb_document_search tag filter cost', () => {
  it('reads each bearer tag a bounded number of times, however long the filter', async () => {
    const NODES = 40
    const TAGS_EACH = 32
    const { deps, last } = await seededBoard(NODES, TAGS_EACH)
    const tally = { reads: 0 }
    let bearersSeen = 0
    const tool = toolOver(deps, (facts) => ({
      ...facts,
      bearers: facts.bearers.map((bearer) => {
        bearersSeen += 1
        return { ...bearer, tags: counted(bearer.tags, tally) }
      }),
    }))

    const readsFor = async (copies: number) => {
      tally.reads = 0
      const out = await tool.execute({ workspaceId: WS, tags: Array(copies).fill(last) })
      expect(out.results).toHaveLength(1)
      expect(out.results[0]?.contexts).toHaveLength(NODES)
      return tally.reads
    }

    const short = await readsFor(64)
    const long = await readsFor(128)
    // The subject is present: every seeded node reached the filter as a bearer.
    expect(bearersSeen).toBeGreaterThanOrEqual(2 * NODES)
    const totalTags = NODES * TAGS_EACH
    // Repeating a tag already listed adds nothing to judge.
    expect(long).toBeLessThan(short * 1.5)
    expect(long).toBeLessThanOrEqual(2 * (totalTags + 128))
  })
})

describe('wb_document_search tag filter set-up cost', () => {
  it('indexes the filter once per search, not once per document', async () => {
    const DOCUMENTS = 40
    const FILTER = 1000
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    for (let i = 0; i < DOCUMENTS; i += 1) {
      await wbDocumentCreate(deps, { workspaceId: WS, path: `note-${i}`, kind: 'markdown' })
    }
    const filter = Array.from({ length: FILTER }, (_, i) => `wanted-${i}`)
    // `new Set(iterable)` inserts through `add`, so a patched `add` sees the
    // filter being indexed however the tool builds its set. No document
    // carries a filter tag, so no other insertion of one is possible. Patched
    // by hand: a spy's own bookkeeping inserts into a Set and recurses.
    const realAdd = Set.prototype.add
    let inserted = 0
    Set.prototype.add = function <T>(this: Set<T>, value: T) {
      if (typeof value === 'string' && value.startsWith('wanted-')) inserted += 1
      return realAdd.call(this, value)
    }
    try {
      const out = await createDocumentSearchTool(deps, vectorCacheFor(deps)).execute({
        workspaceId: WS,
        tags: filter,
      })
      expect(out.results).toEqual([])
    } finally {
      Set.prototype.add = realAdd
    }
    // The subject is present: the filter was indexed at least once.
    expect(inserted).toBeGreaterThanOrEqual(FILTER)
    // Indexing it per document inserted 40,000.
    expect(inserted).toBeLessThanOrEqual(2 * FILTER)
  })
})

/** The filter as first written, kept verbatim as the oracle. */
function carryingByOldRule(bearers: readonly Bearer[], wanted: readonly string[]): Bearer[] {
  return bearers.filter((bearer) => wanted.every((tag) => bearer.tags.includes(tag)))
}

describe('wb_document_search tag filter results', () => {
  const tag = fc.constantFrom('a', 'b', 'c', 'd', 'k:v', 'missing')
  const bearer = fc.record({
    text: fc.constantFrom('', 'x', 'y', 'z'),
    tags: fc.array(tag, { maxLength: 6 }),
  })

  it('admits and names exactly what the original filter did', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    await wbDocumentCreate(deps, { workspaceId: WS, path: 'board', kind: 'spatial' })
    let current: readonly Bearer[] = []
    const tool = toolOver(deps, (facts) => ({ ...facts, texts: [], bearers: current }))
    let admitted = 0
    let refused = 0

    await fc.assert(
      fc.asyncProperty(
        fc.array(bearer, { maxLength: 6 }),
        fc.array(tag, { minLength: 1, maxLength: 6 }),
        async (drawn, wanted) => {
          current = drawn.map((b, i) => ({ what: 'node', id: `n${i}`, ...b }))
          const carrying = carryingByOldRule(current, wanted)
          const out = await tool.execute({ workspaceId: WS, tags: wanted })
          if (carrying.length === 0) {
            refused += 1
            expect(out.results).toEqual([])
            return
          }
          admitted += 1
          expect(out.results).toHaveLength(1)
          expect(out.results[0]?.contexts).toEqual(
            carrying.filter((b) => b.text.length > 0).map((b) => b.text),
          )
        },
      ),
      withDefaults({ numRuns: 300 }),
    )
    // Both outcomes are reached, so the comparison is not vacuous either way.
    expect(admitted).toBeGreaterThan(20)
    expect(refused).toBeGreaterThan(20)
  })
})
