import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { folderNamesOf } from './folder-names.js'
import { fullTextSearch, type SearchableDocument } from './full-text.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const names = new Map([
  ['quipe-ops', 'Operations Team'],
  ['quipe-ops/q3', 'Third quarter'],
])

describe('folderNamesOf', () => {
  it('answers the names of the named folders a document sits in, top down', () => {
    expect(folderNamesOf('quipe-ops/q3/untitled-8', names)).toEqual([
      'Operations Team',
      'Third quarter',
    ])
    expect(folderNamesOf('quipe-ops/untitled-8', names)).toEqual(['Operations Team'])
    // A folder's own name is not the document's, and an unnamed folder's
    // segment is already in the path.
    expect(folderNamesOf('quipe-ops', names)).toEqual([])
    expect(folderNamesOf('other/doc', names)).toEqual([])
  })
})

describe('fullTextSearch over folder names', () => {
  const inFolder: SearchableDocument = {
    documentId: 'in-folder',
    path: 'quipe-ops/untitled-8',
    name: 'Rota',
    texts: ['who is on call this week'],
    folders: ['Operations Team'],
  }

  it('finds a document by the display name of the folder it sits in', () => {
    const outside = { documentId: 'out', path: 'misc/notes', texts: ['nothing relevant'] }
    expect(fullTextSearch([inFolder, outside], 'operations').map((hit) => hit.documentId)).toEqual([
      'in-folder',
    ])
  })

  it('ranks a hit in the folder name below a hit in the document itself', () => {
    const own = {
      documentId: 'own',
      path: 'reports/long-review',
      name: 'Quarterly review',
      // A long body, so length normalisation alone would sink it below the
      // short document whose folder matched.
      texts: [`operations ${'filler words about something else entirely '.repeat(40)}`],
    }
    const hits = fullTextSearch([inFolder, own], 'operations')
    expect(hits.map((hit) => hit.documentId)).toEqual(['own', 'in-folder'])
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY)
  })

  const word = fc.constantFrom('alpha', 'beta', 'gamma', 'plan', 'team')
  const words = fc.array(word, { minLength: 1, maxLength: 20 }).map((ws) => ws.join(' '))
  const corpus = fc.array(fc.tuple(words, fc.option(words, { nil: undefined })), {
    minLength: 1,
    maxLength: 8,
  })

  const tally = { mixed: 0 }

  fcTest.prop([corpus, word], withDefaults({ numRuns: 300 }))(
    'never ranks a folder-only hit above a document whose own text matched',
    (docs, query) => {
      const searchable = docs.map(([text, folder], i) => ({
        documentId: `d${i}`,
        path: `d${i}`,
        texts: [text],
        ...(folder === undefined ? {} : { folders: [folder] }),
      }))
      const hits = fullTextSearch(searchable, query, { limit: 50 })
      const ownMatch = hits.map((hit) => {
        const doc = searchable.find((each) => each.documentId === hit.documentId)
        return doc?.texts.some((text) => text.split(' ').includes(query)) ?? false
      })
      const firstFolderOnly = ownMatch.indexOf(false)
      if (firstFolderOnly > 0) tally.mixed++
      if (firstFolderOnly !== -1) expect(ownMatch.slice(firstFolderOnly)).not.toContain(true)
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(hits[i]?.score ?? 0)
      }
    },
  )

  afterAllFloor(['never ranks a folder-only hit above a document whose own text matched'], () => {
    // Without a response holding both kinds of hit, the order is never decided.
    expect(tally.mixed).toBeGreaterThan(60)
  })
})
