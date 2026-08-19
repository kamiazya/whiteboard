import { describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { searchDocuments } from './search-documents.js'

const docs: WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'design/login', name: 'Login flow' },
  { documentId: 'd2', path: 'design/notes/kickoff', name: 'Kickoff' },
  { documentId: 'd3', path: 'inbox/triage', name: 'Triage' },
  { documentId: 'd4', path: 'archive/old-login' },
]

describe('searchDocuments', () => {
  // You search because you do not know where it is: the results come from
  // everywhere, including folders that are collapsed or unvisited.
  it('searches the whole workspace', () => {
    expect(searchDocuments(docs, 'login').map((d) => d.path)).toEqual([
      'archive/old-login',
      'design/login',
    ])
  })

  it('matches the display name as well as the path', () => {
    expect(searchDocuments(docs, 'kickoff').map((d) => d.path)).toEqual(['design/notes/kickoff'])
    expect(searchDocuments(docs, 'Triage').map((d) => d.path)).toEqual(['inbox/triage'])
  })

  it('ignores case and surrounding space', () => {
    expect(searchDocuments(docs, '  LOGIN  ').map((d) => d.path)).toEqual([
      'archive/old-login',
      'design/login',
    ])
  })

  // Results come from everywhere, so the order has to be one a reader can
  // predict — by address, which is also how they are grouped on screen.
  it('orders results by path', () => {
    expect(searchDocuments(docs, 'i').map((d) => d.path)).toEqual([
      'archive/old-login',
      'design/login',
      'design/notes/kickoff',
      'inbox/triage',
    ])
  })

  // An empty query is not a search: the caller shows the folder instead, and
  // answering "everything" here would make that decision twice.
  it('answers nothing at all for an empty query', () => {
    expect(searchDocuments(docs, '')).toEqual([])
    expect(searchDocuments(docs, '   ')).toEqual([])
  })
})
