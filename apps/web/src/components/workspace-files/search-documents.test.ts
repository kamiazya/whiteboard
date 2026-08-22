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

  // `flow`, not `kickoff`: every other name in this fixture is a substring of
  // its own path, so a query that hits both proves nothing about which half
  // answered. Only a name the path does NOT contain reaches the rule —
  // without this, deleting name-matching outright leaves the file green.
  it('matches the display name as well as the path', () => {
    expect(searchDocuments(docs, 'flow').map((d) => d.path)).toEqual(['design/login'])
    expect(searchDocuments(docs, 'kickoff').map((d) => d.path)).toEqual(['design/notes/kickoff'])
  })

  // The name has to survive the hand-off into the shared matcher, which is
  // this module's own wiring: the other caller's tests guard the matcher,
  // not the row shape handed to it from here.
  it('passes the whole row to the matcher, not just its path', () => {
    const named = [{ documentId: 'x', path: 'a/b', name: 'Quarterly plan' }]
    expect(searchDocuments(named, 'quarterly').map((d) => d.path)).toEqual(['a/b'])
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

describe('searchDocuments pinned order', () => {
  // Same contract as the folder pane: a pinned document outranks the path
  // sort, because the user put it there by hand.
  it('lists pinned matches first, in pinOrder', () => {
    // The pinned document is the one the path sort would put LAST — a
    // fixture where it already sorts first would pass without the rule.
    const pinnable: WorkspaceDocumentEntry[] = [
      { documentId: 'd1', path: 'archive/old-login' },
      { documentId: 'd4', path: 'design/login', pinOrder: 0 },
    ]
    expect(searchDocuments(pinnable, 'login').map((d) => d.path)).toEqual([
      'design/login',
      'archive/old-login',
    ])
  })
})
