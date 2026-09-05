import { describe, expect, it } from 'vitest'
import { fileRefOptions, linkEntries, linkTargets, linkTitles } from './link-entries.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

describe('linkEntries', () => {
  // Display names are retired from resolution: the path is the written
  // form (a move follows it), and the name labels the link at render time.
  it('never resolves a display name', () => {
    const entries = linkEntries([
      { path: 'untitled-2', id: ID, displayName: '週次レビュー', kind: 'markdown' },
    ])
    expect(entries).toEqual([{ id: ID, name: 'untitled-2' }])
  })

  it('offers only the path for a document nobody renamed', () => {
    const entries = linkEntries([{ path: 'untitled', id: ID, kind: 'spatial' }])
    expect(entries).toEqual([{ id: ID, name: 'untitled' }])
  })

  // With names out of the table, another document's name colliding with a
  // path cannot shadow it: the path stays the alias's only owner.
  it('a display name colliding with a path leaves the path resolvable', () => {
    const entries = linkEntries([
      { path: 'untitled-2', id: ID, kind: 'spatial' },
      { path: 'notes', id: OTHER, displayName: 'untitled-2', kind: 'spatial' },
    ])
    expect(entries.filter((e) => e.name === 'untitled-2')).toEqual([{ id: ID, name: 'untitled-2' }])
  })
})

describe('linkTitles', () => {
  it('labels by display name, falling back to the path, unknown ids to nothing', () => {
    const titleOf = linkTitles([
      { path: 'untitled-2', id: ID, displayName: '週次レビュー', kind: 'markdown' },
      { path: 'notes', id: OTHER, kind: 'spatial' },
    ])
    expect(titleOf(ID)).toBe('週次レビュー')
    expect(titleOf(OTHER)).toBe('notes')
    expect(titleOf('01ARZ3NDEKTSV4RRFFQ69G5FAX')).toBeUndefined()
  })
})

describe('linkTargets', () => {
  // The picker is a list a human reads, so each document appears once under
  // the name it is known by.
  it('lists each document once, under its display name when it has one', () => {
    expect(
      linkTargets([
        { path: 'untitled-2', id: ID, displayName: '週次レビュー', kind: 'markdown' },
        { path: 'notes', id: OTHER, kind: 'spatial' },
      ]),
    ).toEqual([
      { id: ID, path: 'untitled-2', name: '週次レビュー', kind: 'markdown' },
      { id: OTHER, path: 'notes', name: 'notes', kind: 'spatial' },
    ])
  })

  it('leaves the open document out of its own link targets', () => {
    const documents = [
      { path: 'self', id: 'id-self', displayName: 'Self', kind: 'spatial' as const },
      { path: 'other', id: 'id-other', displayName: 'Other', kind: 'spatial' as const },
    ]
    const targets = linkTargets(documents, { excludeDocumentId: 'id-self' })
    expect(targets.map((t) => t.id)).toEqual(['id-other'])
    // Without the exclusion everything stays listed (existing callers).
    expect(linkTargets(documents).map((t) => t.id)).toEqual(['id-self', 'id-other'])
  })
})

describe('fileRefOptions', () => {
  // The file-node picker is the third list built from the same rows; its
  // rows are the link targets under different field names, so it derives
  // from them rather than being built inline a third time per page.
  it('projects link targets onto the picker rows, label included', () => {
    expect(
      fileRefOptions([
        { id: ID, path: 'untitled-2', name: '週次レビュー', kind: 'markdown' },
        { id: OTHER, path: 'notes', name: 'notes', kind: 'spatial' },
      ]),
    ).toEqual([
      { file: ID, label: '週次レビュー', kind: 'markdown' },
      { file: OTHER, label: 'notes', kind: 'spatial' },
    ])
  })
})

describe('a browser-kept row through the same table', () => {
  // The browser page projects {documentId, name} onto the same shape the
  // daemon page uses, so one module owns resolution for both keepers. A
  // browser row's `name` is required, so the fallback arm never fires — the
  // projection hands it over as the displayName and the label is identical
  // to what the page used to build inline.
  const projected = [
    { id: ID, path: 'plan/roadmap', displayName: 'Roadmap', kind: 'markdown' as const },
    { id: OTHER, path: 'untitled-3', displayName: 'untitled-3', kind: 'spatial' as const },
  ]

  it('resolves by path, labels by name, excludes the open document', () => {
    expect(linkEntries(projected)).toEqual([
      { id: ID, name: 'plan/roadmap' },
      { id: OTHER, name: 'untitled-3' },
    ])
    expect(linkTitles(projected)(ID)).toBe('Roadmap')
    expect(linkTargets(projected, { excludeDocumentId: ID }).map((t) => t.id)).toEqual([OTHER])
  })
})
