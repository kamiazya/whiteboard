import { describe, expect, it } from 'vitest'
import { resolveReferencesForExport } from './resolve-for-export.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function withWikiLink(alias?: string) {
  return {
    type: 'root' as const,
    children: [
      {
        type: 'paragraph' as const,
        children: [{ type: 'wikiLink' as const, canvasId: ULID, alias }],
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
})
