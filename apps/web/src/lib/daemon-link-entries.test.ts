import { describe, expect, it } from 'vitest'
import { daemonLinkEntries, daemonLinkTargets } from './daemon-link-entries.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

describe('daemonLinkEntries', () => {
  // The display name is the only identifier any screen shows, so it is the
  // one a reference is written with. The path is an auto-generated address
  // nothing invites you to type.
  it('resolves a reference by the display name the user can see', () => {
    const entries = daemonLinkEntries([
      { path: 'untitled-2', id: ID, displayName: '週次レビュー', updatedAt: '' },
    ])
    expect(entries).toContainEqual({ id: ID, name: '週次レビュー' })
  })

  // The path is the addressable identity and stays typeable, which is what
  // makes a link survive a rename.
  it('keeps the path resolvable alongside the name', () => {
    const entries = daemonLinkEntries([
      { path: 'untitled-2', id: ID, displayName: '週次レビュー', updatedAt: '' },
    ])
    expect(entries).toContainEqual({ id: ID, name: 'untitled-2' })
  })

  it('offers only the path for a document nobody renamed', () => {
    const entries = daemonLinkEntries([{ path: 'untitled', id: ID, updatedAt: '' }])
    expect(entries).toEqual([{ id: ID, name: 'untitled' }])
  })

  it('falls back to the path as an id when an older daemon omits one', () => {
    const entries = daemonLinkEntries([{ path: 'untitled', updatedAt: '' }])
    expect(entries).toEqual([{ id: 'untitled', name: 'untitled' }])
  })

  // Left for the resolver's own ambiguity rule to reject rather than
  // silently picking one — a name colliding with another document's path is
  // exactly the case where guessing is worse than a literal.
  it('emits both colliding entries rather than dropping one', () => {
    const entries = daemonLinkEntries([
      { path: 'untitled-2', id: ID, updatedAt: '' },
      { path: 'notes', id: OTHER, displayName: 'untitled-2', updatedAt: '' },
    ])
    expect(entries.filter((e) => e.name === 'untitled-2')).toHaveLength(2)
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
        { path: 'notes', id: OTHER, updatedAt: '' },
      ]),
    ).toEqual([
      { id: ID, name: '週次レビュー', kind: 'markdown' },
      { id: OTHER, name: 'notes' },
    ])
  })
})
