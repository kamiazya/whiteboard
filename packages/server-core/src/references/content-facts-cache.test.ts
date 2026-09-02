import { describe, expect, it, vi } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import { ContentFactsCache } from './content-facts-cache.js'

const WS = 'ws-1'

function makeDeps(): ServerDeps {
  return makeTestDeps()
}

async function seedTwo(deps: ReturnType<typeof makeDeps>) {
  // The workspace exists because this fixture says so, not as a side effect
  // of the first create: creating one is ADR-0019's MINT boundary, which
  // keys it by a fresh ULID and would leave the literal below naming nothing.
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const create = (path: string, name?: string) =>
    wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind: 'markdown',
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
  it('alternating workspaces never evict each other (regression: cross-workspace thrash)', async () => {
    const deps = makeDeps()
    await seedTwo(deps) // ws-1
    const OTHER = 'ws-2'
    await deps.documentIndex.createWorkspace({ workspaceId: OTHER })
    const c = await wbDocumentCreate(deps, {
      workspaceId: OTHER,
      path: 'c',
      kind: 'markdown',
      name: 'Gamma',
    })
    await createDocumentSetTool(deps).execute({
      workspaceId: OTHER,
      documentId: c.documentId,
      markdown: '---\ntype: note\n---\ngamma body',
    })
    const cache = new ContentFactsCache()
    const ws1 = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const ws2 = await deps.documentIndex.listDocuments({ workspaceId: OTHER })
    await cache.factsFor(deps, WS, ws1)
    await cache.factsFor(deps, OTHER, ws2)

    const loads = vi.spyOn(deps.documentStore, 'loadSnapshot')
    await cache.factsFor(deps, WS, ws1)
    await cache.factsFor(deps, OTHER, ws2)
    await cache.factsFor(deps, WS, ws1)
    expect(loads).not.toHaveBeenCalled()
  })

  it('a kind flip without a content change re-extracts (the kind is part of the stamp)', async () => {
    const deps = makeDeps()
    const { a } = await seedTwo(deps)
    const cache = new ContentFactsCache()
    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const first = await cache.factsFor(deps, WS, entries)
    expect(first.get(a.documentId)?.texts[0]).toContain('alpha body')

    // No listing-only kind mutation exists today; hand a re-kinded entry to
    // pin the latent trap: extraction branches on entry.kind, so cached
    // facts are only valid FOR the kind they were extracted under.
    const flipped = entries.map((entry) =>
      entry.documentId === a.documentId ? { ...entry, kind: 'spatial' as const } : entry,
    )
    const second = await cache.factsFor(deps, WS, flipped)
    // A markdown doc read as spatial has no text nodes: facts must change.
    expect(second.get(a.documentId)?.texts).toEqual([])
  })

  it('loads every document once, then nothing while frontiers stand still', async () => {
    const deps = makeDeps()
    await seedTwo(deps)
    const loads = vi.spyOn(deps.documentStore, 'loadSnapshot')
    const cache = new ContentFactsCache()

    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const first = await cache.factsFor(deps, WS, entries)
    expect(first.size).toBe(2)
    expect(loads).toHaveBeenCalledTimes(2)

    loads.mockClear()
    const second = await cache.factsFor(deps, WS, entries)
    expect(second.get(entries[0]?.documentId ?? '')?.texts[0]).toContain('alpha body one')
    expect(loads).not.toHaveBeenCalled()
  })

  it('reloads exactly the edited document', async () => {
    const deps = makeDeps()
    const { b, write } = await seedTwo(deps)
    const cache = new ContentFactsCache()
    const entries = await deps.documentIndex.listDocuments({ workspaceId: WS })
    await cache.factsFor(deps, WS, entries)

    await write(b.documentId, 'beta body two')
    const loads = vi.spyOn(deps.documentStore, 'loadSnapshot')
    const facts = await cache.factsFor(deps, WS, entries)
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
    const facts = await cache.factsFor(deps, WS, all)
    expect(facts.get(empty.documentId)).toEqual({ refs: [], texts: [], tags: undefined })
    // Two seeded documents loaded; the snapshotless one never was.
    expect(loads).toHaveBeenCalledTimes(2)

    await deps.documentIndex.deleteDocument({ workspaceId: WS, path: 'a' })
    const after = await cache.factsFor(
      deps,
      WS,
      await deps.documentIndex.listDocuments({ workspaceId: WS }),
    )
    expect(after.has(a.documentId)).toBe(false)
  })

  it('carries content tags for the tags projection', async () => {
    const deps = makeDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const doc = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'tagged',
      kind: 'markdown',
    })
    await createDocumentSetTool(deps).execute({
      workspaceId: WS,
      documentId: doc.documentId,
      markdown: '---\ntype: note\ntags:\n  - release\n---\nbody',
    })
    const cache = new ContentFactsCache()
    const facts = await cache.factsFor(
      deps,
      WS,
      await deps.documentIndex.listDocuments({ workspaceId: WS }),
    )
    expect(facts.get(doc.documentId)?.tags).toEqual(['release'])
  })
})
