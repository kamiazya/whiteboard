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
