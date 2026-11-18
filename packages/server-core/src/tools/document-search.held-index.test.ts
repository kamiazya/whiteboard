import { installSearchCore, type SearchCore } from '@kamiazya/whiteboard-search'
import { afterEach, describe, expect, it } from 'vitest'
import { vectorCacheFor } from '../search/document-vector-cache.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSearchTool } from './document-search.js'
import { createDocumentSetOperation } from './document-set.js'

// An unfiltered query ranks over terms the core holds between queries and
// sends a document again only when it changed; a filtered one ranks its own
// corpus, since BM25 is relative to it.

const WS = '01ZVM89A4A1V9FS03Z9J64KEK1'

let realm: SearchCore | undefined
afterEach(() => {
  if (realm !== undefined) installSearchCore(realm)
  realm = undefined
})

/** The documents sent to every index the core made, counted by id. */
function counting() {
  const real = installSearchCore(undefined)
  if (real === undefined) throw new Error('the test realm installs a search core')
  realm = real
  const sent: string[] = []
  installSearchCore({
    ...real,
    createIndex: () => {
      const index = real.createIndex()
      return {
        ...index,
        upsert: (doc, alsoIndex) => {
          sent.push(doc.documentId)
          return index.upsert(doc, alsoIndex)
        },
        remove: (id) => index.remove(id),
        search: (query, limit) => index.search(query, limit),
        release: () => index.release(),
      }
    },
  })
  return sent
}

async function workspace() {
  const deps = makeTestDeps()
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const set = createDocumentSetOperation(deps)
  const write = async (path: string, body: string, tags = '') => {
    const doc = await wbDocumentCreate(deps, { workspaceId: WS, path, kind: 'markdown' })
    await set.execute({
      workspaceId: WS,
      documentId: doc.documentId,
      markdown: `---\ntype: note\n${tags}---\n${body}`,
    })
    return doc.documentId
  }
  return { deps, write, set }
}

describe('wb_document_search terms held between queries', () => {
  it('sends each document once, not again on each query', async () => {
    const { deps, write } = await workspace()
    await write('a', 'rocket launch window')
    await write('b', 'launch checklist')
    const sent = counting()
    const tool = createDocumentSearchTool(deps, vectorCacheFor(deps))
    const first = await tool.execute({ workspaceId: WS, query: 'launch' })
    expect(sent).toHaveLength(2)
    const second = await tool.execute({ workspaceId: WS, query: 'launch' })
    expect(sent).toHaveLength(2)
    expect(second).toEqual(first)
  })

  it('sends a document again once its body, path or name changed, and forgets a deleted one', async () => {
    const { deps, write, set } = await workspace()
    const a = await write('a', 'rocket launch')
    const b = await write('b', 'rocket staging')
    const sent = counting()
    const tool = createDocumentSearchTool(deps, vectorCacheFor(deps))
    const ids = async (query: string) =>
      (await tool.execute({ workspaceId: WS, query })).results.map((r) => r.documentId).sort()
    expect(await ids('rocket')).toEqual([a, b].sort())
    expect(sent).toHaveLength(2)

    await set.execute({
      workspaceId: WS,
      documentId: a,
      markdown: '---\ntype: note\n---\nsatellite orbit',
    })
    expect(await ids('rocket')).toEqual([b])
    expect(await ids('satellite')).toEqual([a])
    expect(sent.filter((id) => id === a)).toHaveLength(2)
    expect(sent.filter((id) => id === b)).toHaveLength(1)

    await deps.documentIndex.moveDocument({ workspaceId: WS, from: 'b', to: 'missions/apollo' })
    expect(await ids('apollo')).toEqual([b])
    await deps.documentIndex.setDocumentName({ workspaceId: WS, documentId: b, name: 'Gemini' })
    expect(await ids('gemini')).toEqual([b])
    expect(sent.filter((id) => id === b)).toHaveLength(3)

    await deps.documentIndex.deleteDocument({ workspaceId: WS, path: 'missions/apollo' })
    expect(await ids('rocket')).toEqual([])
  })

  it('scores a filtered query within the documents it admits, as a corpus of its own', async () => {
    const { deps, write } = await workspace()
    const tagged = await write('a', 'rocket launch', 'tags:\n  - ops\n')
    await write('b', 'rocket staging')
    await write('c', 'garden notes')
    const tool = createDocumentSearchTool(deps, vectorCacheFor(deps))
    const all = await tool.execute({ workspaceId: WS, query: 'rocket' })
    const filtered = await tool.execute({ workspaceId: WS, query: 'rocket', tags: ['ops'] })
    expect(filtered.results.map((r) => r.documentId)).toEqual([tagged])
    const scoreAll = all.results.find((r) => r.documentId === tagged)?.score
    expect(filtered.results[0]?.score).not.toBe(scoreAll)
  })
})

describe('wb_document_search when the core is out of budget for another workspace', () => {
  // The core's held memory is shared by every index it holds, so a workspace
  // that needs one may find the budget spent on others this process kept.
  // A stand-in core with room for one index at a time makes that exact.
  function budgetOfOneIndex() {
    const real = installSearchCore(undefined)
    if (real === undefined) throw new Error('the test realm installs a search core')
    realm = real
    const state = { live: 0, released: 0 }
    const full = () => {
      const err = new Error('the core holds no more')
      err.name = 'CoreInputRefused'
      return err
    }
    installSearchCore({
      ...real,
      createIndex: () => {
        if (state.live >= 1) throw full()
        state.live++
        const index = real.createIndex()
        let released = false
        return {
          ...index,
          upsert: (doc, alsoIndex) => index.upsert(doc, alsoIndex),
          remove: (id) => index.remove(id),
          search: (query, limit) => index.search(query, limit),
          release: () => {
            if (released) return
            released = true
            state.live--
            state.released++
            index.release()
          },
        }
      },
      // The stateless ranking builds an index of its own inside the core.
      fullTextSearch: (documents, query, options) => {
        if (state.live >= 1) throw full()
        return real.fullTextSearch(documents, query, options)
      },
    })
    return state
  }

  it('releases the indexes it kept for other workspaces and holds this one', async () => {
    const first = await workspace()
    await first.write('a', 'rocket launch window')
    const second = await workspace()
    await second.write('b', 'rocket staging area')
    const state = budgetOfOneIndex()
    const one = createDocumentSearchTool(first.deps, vectorCacheFor(first.deps))
    const two = createDocumentSearchTool(second.deps, vectorCacheFor(second.deps))

    expect((await one.execute({ workspaceId: WS, query: 'rocket' })).results).toHaveLength(1)
    expect(state.live).toBe(1)
    expect((await two.execute({ workspaceId: WS, query: 'rocket' })).results).toHaveLength(1)
    expect(state.released).toBe(1)
    expect(state.live).toBe(1)
  })

  it('does the same for a filtered query, which ranks its own corpus', async () => {
    const first = await workspace()
    await first.write('a', 'rocket launch window')
    const second = await workspace()
    await second.write('b', 'rocket staging area', 'tags:\n  - ops\n')
    const state = budgetOfOneIndex()
    const one = createDocumentSearchTool(first.deps, vectorCacheFor(first.deps))
    const two = createDocumentSearchTool(second.deps, vectorCacheFor(second.deps))

    await one.execute({ workspaceId: WS, query: 'rocket' })
    expect(state.live).toBe(1)
    const out = await two.execute({ workspaceId: WS, query: 'rocket', tags: ['ops'] })
    expect(out.results).toHaveLength(1)
    expect(state.released).toBe(1)
  })

  it('finishes an index refused partway through, keeping what it already sent', async () => {
    const first = await workspace()
    await first.write('a', 'rocket launch window')
    const second = await workspace()
    await second.write('b', 'rocket staging area')
    await second.write('c', 'rocket fuel depot')
    // Room for two documents across every index, so the second workspace's
    // second document is refused until the first workspace's index goes.
    const real = installSearchCore(undefined)
    if (real === undefined) throw new Error('the test realm installs a search core')
    realm = real
    const state = { heldDocs: 0, released: 0, sent: [] as string[] }
    installSearchCore({
      ...real,
      createIndex: () => {
        const index = real.createIndex()
        let mine = 0
        return {
          ...index,
          upsert: (doc, alsoIndex) => {
            if (state.heldDocs >= 2) {
              const err = new Error('the core holds no more')
              err.name = 'CoreInputRefused'
              throw err
            }
            state.heldDocs++
            mine++
            state.sent.push(doc.documentId)
            return index.upsert(doc, alsoIndex)
          },
          remove: (id) => index.remove(id),
          search: (query, limit) => index.search(query, limit),
          release: () => {
            state.heldDocs -= mine
            mine = 0
            state.released++
            index.release()
          },
        }
      },
    })
    const one = createDocumentSearchTool(first.deps, vectorCacheFor(first.deps))
    const two = createDocumentSearchTool(second.deps, vectorCacheFor(second.deps))

    await one.execute({ workspaceId: WS, query: 'rocket' })
    const out = await two.execute({ workspaceId: WS, query: 'rocket' })
    expect(out.results).toHaveLength(2)
    expect(state.released).toBe(1)
    // The document sent before the refusal is not sent again.
    expect(state.sent).toHaveLength(3)
  })
})
