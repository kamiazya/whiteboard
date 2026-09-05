// The picker WRITES markup that the codec READS back. Asserting the string
// only pins one half of that, and the half that matters is whether the
// reference survives the reader — a single `]` in an alias produced a string
// that looked right and resolved to nothing. So this test runs what
// `linkMarkupFor` emits through the real parser and reference resolver, and
// asserts the result is exactly one link with no literal remainder.
//
// It lives here, not in codec: apps/web may depend on codec, and the reverse
// import would be an architecture violation.
import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import { type LinkTarget, linkMarkupFor } from './link-target.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const target: LinkTarget = {
  id: ID,
  path: 'reviews/weekly',
  name: 'Weekly review',
  kind: 'markdown',
}
// The reader resolves PATHS (display names are retired from resolution).
const resolver = (alias: string) => (alias === 'reviews/weekly' ? ID : null)

function nodeTypesFor(markup: string): string[] {
  const root = resolveReferences(parseMarkdownBody(markup), resolver)
  const paragraph = root.children[0] as { children: { type: string }[] }
  return paragraph.children.map((child) => child.type)
}

describe('what the picker writes is what the codec reads', () => {
  it.each([
    ['last week'],
    ['a|b'],
    ['Draft] proposal'],
    ['note]'],
    ['a ]] b'],
    ['two\nlines'],
  ])('display text %j resolves to one wikiLink and no stray text', (text) => {
    expect(nodeTypesFor(linkMarkupFor(target, [target], text))).toEqual(['wikiLink'])
  })

  it('a path shaped exactly like a document id still links (by the id form)', () => {
    // The references syntax carries no scheme, so that spelling IS the id
    // form and cannot be written as a target.
    const odd: LinkTarget = {
      id: ID,
      path: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      name: 'Shadowy',
      kind: 'markdown',
    }
    expect(nodeTypesFor(linkMarkupFor(odd, [odd]))).toEqual(['wikiLink'])
  })

  it.each([
    ['single ] bracket'],
    ['A|B'],
    ['weird ]] name'],
  ])('a document NAMED %j still links when the path falls back to the id', (name) => {
    // An unwritable path cannot come out of documentPathSchema, but the
    // fallback still has to survive an unwritable NAME in the alias slot.
    const odd: LinkTarget = { id: ID, path: '01BX5ZZKBKACTAV9WEVGEMMVRZ', name, kind: 'markdown' }
    expect(nodeTypesFor(linkMarkupFor(odd, [odd]))).toEqual(['wikiLink'])
  })

  it('resolves the ordinary case through the same path, so the harness is honest', () => {
    expect(nodeTypesFor(linkMarkupFor(target, [target]))).toEqual(['wikiLink'])
  })
})
