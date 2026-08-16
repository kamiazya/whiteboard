import { describe, expect, it } from 'vitest'
import { resolveReferencesForExport } from './resolve-for-export.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function withWikiLink(alias?: string) {
  return {
    type: 'root' as const,
    children: [
      {
        type: 'paragraph' as const,
        children: [{ type: 'wikiLink' as const, documentId: ULID, alias }],
      },
    ],
  }
}

describe('resolveReferencesForExport', () => {
  it('rewrites a resolved wikiLink into a relative-path markdown link', () => {
    const root = withWikiLink('My Note')
    const exported = resolveReferencesForExport(root, () => '../notes/my-note.md')

    const paragraph = exported.children[0]
    if (paragraph.type !== 'paragraph') throw new Error('expected paragraph')
    expect(paragraph.children).toEqual([{ type: 'text', value: '[My Note](../notes/my-note.md)' }])
  })

  it('leaves an unresolved wikiLink as literal text', () => {
    const root = withWikiLink()
    const exported = resolveReferencesForExport(root, () => null)

    const paragraph = exported.children[0]
    if (paragraph.type !== 'paragraph') throw new Error('expected paragraph')
    expect(paragraph.children).toEqual([{ type: 'text', value: `[[canvas:${ULID}]]` }])
  })

  it('is idempotent: applying twice with the same resolver equals applying once', () => {
    const root = withWikiLink('My Note')
    const resolver = () => '../notes/my-note.md'

    const once = resolveReferencesForExport(root, resolver)
    // A second pass over already-exported (now plain-text) content must be a
    // no-op — there is nothing left of wikiLink-shape to resolve.
    const twice = resolveReferencesForExport(once, resolver)

    expect(twice).toEqual(once)
  })

  it('rewrites a wikiLink nested inside a list item', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'list' as const,
          children: [
            {
              type: 'listItem' as const,
              children: [
                {
                  type: 'paragraph' as const,
                  children: [{ type: 'wikiLink' as const, documentId: ULID, alias: 'My Note' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const exported = resolveReferencesForExport(root, () => '../notes/my-note.md')

    const list = exported.children[0]
    if (list.type !== 'list') throw new Error('expected list')
    const paragraphNode = list.children[0].children[0]
    if (paragraphNode.type !== 'paragraph') throw new Error('expected paragraph')
    expect(paragraphNode.children).toEqual([
      { type: 'text', value: '[My Note](../notes/my-note.md)' },
    ])
  })

  it('rewrites a wikiLink nested inside a table cell', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'table' as const,
          children: [
            {
              type: 'tableRow' as const,
              children: [
                {
                  type: 'tableCell' as const,
                  children: [{ type: 'wikiLink' as const, documentId: ULID, alias: 'My Note' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const exported = resolveReferencesForExport(root, () => '../notes/my-note.md')

    const table = exported.children[0]
    if (table.type !== 'table') throw new Error('expected table')
    const cell = table.children[0].children[0]
    expect(cell.children).toEqual([{ type: 'text', value: '[My Note](../notes/my-note.md)' }])
  })
})
