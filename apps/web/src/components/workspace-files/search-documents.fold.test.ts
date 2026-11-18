// @vitest-environment node
import { foldForSearch } from '@kamiazya/whiteboard-search'
import { expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { searchDocuments } from './search-documents.js'

// The list folds every entry's texts in one core call. That is only the same
// answer if folding apart or together agrees, so it is held against folding
// each text on its own, over the inputs where folding has something to decide.

const piece = fc.constantFrom(
  'a',
  'e',
  'é',
  'é',
  'É',
  'ß',
  'ﬁ',
  'が',
  'ｶﾞ',
  '検索',
  '한',
  'Σ',
  ' ',
  '/',
  '-',
  '́',
  '゙',
  '🚀',
)
const text = fc.array(piece, { maxLength: 8 }).map((parts) => parts.join(''))

fcTest.prop(
  [
    fc.array(fc.record({ path: text, name: fc.option(text, { nil: undefined }) }), {
      maxLength: 8,
    }),
    text,
  ],
  withDefaults({ numRuns: 100 }),
)('matches on each entry exactly as folding each of its texts alone does', (rows, query) => {
  const documents = rows.map((row, i) => ({
    documentId: `d${i}`,
    path: `${row.path}-${i}`,
    ...(row.name === undefined ? {} : { name: row.name }),
  }))
  const q = query.trim().toLowerCase()
  const wanted = foldForSearch(q)
  const reference = documents
    .filter(
      (d) =>
        !q.startsWith('#') &&
        (foldForSearch(d.path).includes(wanted) ||
          (d.name !== undefined && foldForSearch(d.name).includes(wanted))),
    )
    .map((d) => d.documentId)
  const found = searchDocuments(documents, query).map((d) => d.documentId)
  if (q === '') {
    expect(found).toEqual([])
  } else if (!q.startsWith('#')) {
    expect([...found].sort()).toEqual([...reference].sort())
  }
})

fcTest.prop([fc.array(text, { minLength: 1, maxLength: 6 })], withDefaults({ numRuns: 60 }))(
  'a text holding a line break is matched on its own, not split',
  (parts) => {
    const name = parts.join('\n')
    const documents = [{ documentId: 'd', path: 'p', name }]
    const query = parts[0] ?? ''
    if (query.trim() === '' || query.trim().startsWith('#')) return
    const wanted = foldForSearch(query.trim().toLowerCase())
    const expected = foldForSearch('p').includes(wanted) || foldForSearch(name).includes(wanted)
    expect(searchDocuments(documents, query).length === 1).toBe(expected)
  },
)
