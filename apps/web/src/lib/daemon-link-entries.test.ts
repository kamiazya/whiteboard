import { describe, expect, it } from 'vitest'
import { daemonLinkEntries, daemonLinkTargets, daemonLinkTitles } from './daemon-link-entries.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

describe('daemonLinkEntries', () => {
  // Display names are retired from resolution: the path is the written
  // form (a move follows it), and the name labels the link at render time.
  it('never resolves a display name', () => {
    const entries = daemonLinkEntries([
      {
        path: 'untitled-2',
        id: ID,
        displayName: '週次レビュー',
        updatedAt: '',
        kind: 'markdown',
      },
    ])
    expect(entries).toEqual([{ id: ID, name: 'untitled-2' }])
  })

  it('keeps the path resolvable', () => {
    const entries = daemonLinkEntries([
      {
        path: 'untitled-2',
        id: ID,
        displayName: '週次レビュー',
        updatedAt: '',
        kind: 'markdown',
      },
    ])
    expect(entries).toContainEqual({ id: ID, name: 'untitled-2' })
  })

  it('offers only the path for a document nobody renamed', () => {
    const entries = daemonLinkEntries([
      { path: 'untitled', id: ID, updatedAt: '', kind: 'spatial' },
    ])
    expect(entries).toEqual([{ id: ID, name: 'untitled' }])
  })

  // With names out of the table, another document's name colliding with a
  // path cannot shadow it: the path stays the alias's only owner.
  it('a display name colliding with a path leaves the path resolvable', () => {
    const entries = daemonLinkEntries([
      { path: 'untitled-2', id: ID, updatedAt: '', kind: 'spatial' },
      { path: 'notes', id: OTHER, displayName: 'untitled-2', updatedAt: '', kind: 'spatial' },
    ])
    expect(entries.filter((e) => e.name === 'untitled-2')).toEqual([{ id: ID, name: 'untitled-2' }])
  })
})

describe('daemonLinkTitles', () => {
  it('labels by display name, falling back to the path, unknown ids to nothing', () => {
    const titleOf = daemonLinkTitles([
      { path: 'untitled-2', id: ID, displayName: '週次レビュー', updatedAt: '', kind: 'markdown' },
      { path: 'notes', id: OTHER, updatedAt: '', kind: 'spatial' },
    ])
    expect(titleOf(ID)).toBe('週次レビュー')
    expect(titleOf(OTHER)).toBe('notes')
    expect(titleOf('01ARZ3NDEKTSV4RRFFQ69G5FAX')).toBeUndefined()
  })
})

describe('daemonLinkTargets', () => {
  // The picker is a list a human reads, so each document appears once under
  // the name it is known by.
  it('lists each document once, under its display name when it has one', () => {
    expect(
      daemonLinkTargets([
        {
          path: 'untitled-2',
          id: ID,
          displayName: '週次レビュー',
          updatedAt: '',
          kind: 'markdown',
        },
        { path: 'notes', id: OTHER, updatedAt: '', kind: 'spatial' },
      ]),
    ).toEqual([
      { id: ID, path: 'untitled-2', name: '週次レビュー', kind: 'markdown' },
      { id: OTHER, path: 'notes', name: 'notes', kind: 'spatial' },
    ])
  })
})

describe('self-reference exclusion', () => {
  it('daemonLinkTargets leaves the open document out of its own link targets', () => {
    const documents = [
      {
        path: 'self',
        id: 'id-self',
        updatedAt: 't',
        displayName: 'Self',
        kind: 'spatial' as const,
      },
      {
        path: 'other',
        id: 'id-other',
        updatedAt: 't',
        displayName: 'Other',
        kind: 'spatial' as const,
      },
    ]
    const targets = daemonLinkTargets(documents, { excludeDocumentId: 'id-self' })
    expect(targets.map((t) => t.id)).toEqual(['id-other'])
    // Without the exclusion everything stays listed (existing callers).
    expect(daemonLinkTargets(documents).map((t) => t.id)).toEqual(['id-self', 'id-other'])
  })
})
