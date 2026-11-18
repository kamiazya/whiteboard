import { installSearchCore, type SearchCore } from '@kamiazya/whiteboard-search'
import { afterEach, describe, expect, it } from 'vitest'
import type { Embedder } from '../search/embedder.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSearchTool } from './document-search.js'
import { createDocumentSetOperation } from './document-set.js'

// The ranking, the excerpts and the link labels are the realm's search core's.
// An input it declines past its caps is answered as nothing found, nothing
// quoted and nothing labelled; any other failure is the caller's to see.

const WS = '01ZVM89A4A1V9FS03Z9J64KEK1'

const refusal = () => {
  const err = new Error('past the cap')
  err.name = 'CoreInputRefused'
  return err
}

async function searchOver(over: Partial<SearchCore>, embedder?: Embedder) {
  const deps = makeTestDeps()
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const note = await wbDocumentCreate(deps, { workspaceId: WS, path: 'launch', kind: 'markdown' })
  await createDocumentSetOperation(deps).execute({
    workspaceId: WS,
    documentId: note.documentId,
    markdown: '---\ntype: note\n---\nthe rocket launch window',
  })
  const real = installSearchCore(undefined)
  if (real === undefined) throw new Error('the test realm installs a search core')
  restore = real
  installSearchCore({ ...real, ...over })
  return createDocumentSearchTool({
    ...deps,
    ...(embedder === undefined ? {} : { embedder }),
  }).execute({
    workspaceId: WS,
    query: 'rocket',
  })
}

let restore: SearchCore | undefined
afterEach(() => {
  if (restore !== undefined) installSearchCore(restore)
  restore = undefined
})

describe('wb_document_search when the search core declines an input', () => {
  it('finds the document through the installed core', async () => {
    const out = await searchOver({})
    expect(out.results.map((r) => r.path)).toEqual(['launch'])
    expect(out.results[0]?.contexts).toEqual(['the rocket launch window'])
  })

  it('answers no hits for a corpus or query the core declines', async () => {
    const out = await searchOver({
      createIndex: () => {
        throw refusal()
      },
      fullTextSearch: () => {
        throw refusal()
      },
    })
    expect(out).toEqual({ results: [] })
  })

  it('still ranks when the core declines the listing of link labels', async () => {
    const out = await searchOver({
      linkLabels: () => {
        throw refusal()
      },
    })
    expect(out.results.map((r) => r.path)).toEqual(['launch'])
  })

  it('quotes nothing for a page the core declines to excerpt, beside an embedder', async () => {
    const unavailable: Embedder = {
      id: 'unavailable@v1',
      dimensions: 3,
      embed: () => Promise.reject(new Error('model unavailable')),
    }
    const out = await searchOver(
      {
        excerpts: () => {
          throw refusal()
        },
      },
      unavailable,
    )
    expect(out.results.map((r) => [r.path, r.contexts])).toEqual([['launch', []]])
  })

  it('ranks without holding an index when the core will not hold one', async () => {
    const out = await searchOver({
      createIndex: () => {
        throw refusal()
      },
    })
    expect(out.results.map((r) => r.path)).toEqual(['launch'])
  })

  it('does not hide a failure that is not a refusal', async () => {
    await expect(
      searchOver({
        createIndex: () => {
          throw new Error('a defect')
        },
      }),
    ).rejects.toThrowError('a defect')
  })

  it('releases the link labels it held once the search ends', async () => {
    let released = 0
    await searchOver({
      linkLabels: () => ({
        release: () => {
          released++
        },
      }),
    })
    expect(released).toBe(1)
  })
})
