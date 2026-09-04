import { describe, expect, it } from 'vitest'
import { resolveReferences } from './resolve.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function paragraph(text: string) {
  return {
    type: 'root' as const,
    children: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, value: text }] }],
  }
}

describe('resolveReferences', () => {
  it('resolves a bare [[ULID]] directly with no resolver needed', () => {
    const root = paragraph(`see [[${ULID}]] here`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'wikiLink', documentId: ULID, alias: undefined },
      { type: 'text', value: ' here' },
    ])
  })

  // The scheme is gone from the syntax users write, so a body carrying the
  // old form has no privileged meaning left. It reaches the name resolver
  // like any other target and, finding no document called that, stays
  // visible as the literal text the author typed — the honest outcome for a
  // link this version cannot honour.
  it('no longer gives the retired canvas: scheme a meaning of its own', () => {
    const root = paragraph(`see [[canvas:${ULID}]] here`)
    const resolved = resolveReferences(root, () => null)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'text', value: `[[canvas:${ULID}]]` },
      { type: 'text', value: ' here' },
    ])
  })

  it('prefers the id reading over the resolver for a bare ULID target', () => {
    const root = paragraph(`[[${ULID}]]`)
    const resolved = resolveReferences(root, () => {
      throw new Error('resolver must not be consulted for a well-formed document id')
    })

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'wikiLink', documentId: ULID, alias: undefined }])
  })

  it('resolves a bare ![[ULID]] to an embed', () => {
    const root = paragraph(`![[${ULID}]]`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'embed', documentId: ULID }])
  })

  it('a resolved bare [[alias]] carries NO alias — the label is decided at render time', () => {
    // The written target is an ADDRESS, not a caption: a bare [[design/login]]
    // shows the target's current display name wherever one is known, so the
    // node must not freeze the address into the label slot.
    const root = paragraph('[[design/login]]')
    const resolved = resolveReferences(root, (alias) => (alias === 'design/login' ? ULID : null))
    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'wikiLink', documentId: ULID, alias: undefined }])
  })

  it('resolves [[alias]] to a wikiLink when the resolver returns non-null', () => {
    const root = paragraph('[[My Note]]')
    const resolved = resolveReferences(root, (alias) => (alias === 'My Note' ? ULID : null))

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'wikiLink', documentId: ULID, alias: undefined }])
  })

  it('leaves [[alias]] as text when the resolver returns null', () => {
    const root = paragraph('[[Missing]]')
    const resolved = resolveReferences(root, () => null)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: '[[Missing]]' }])
  })

  it('leaves a target that is not a document id and not a known name as text', () => {
    const root = paragraph('[[not-a-ulid]]')
    const resolved = resolveReferences(root, () => null)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: '[[not-a-ulid]]' }])
  })

  it('with no resolver, only a bare [[ULID]] parses — [[alias]] stays text', () => {
    const root = paragraph(`[[${ULID}]] and [[alias]]`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([
      { type: 'wikiLink', documentId: ULID, alias: undefined },
      { type: 'text', value: ' and ' },
      { type: 'text', value: '[[alias]]' },
    ])
  })

  it('supports an explicit alias override: [[ULID|Display Name]]', () => {
    const root = paragraph(`[[${ULID}|Display Name]]`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([
      { type: 'wikiLink', documentId: ULID, alias: 'Display Name' },
    ])
  })

  it('resolves a bare ![[ULID]] to an embed node, not a wikiLink', () => {
    const root = paragraph(`![[${ULID}]]`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'embed', documentId: ULID }])
  })

  it('resolves ![[alias]] to an embed node through the resolver', () => {
    const root = paragraph('![[My Note]]')
    const resolved = resolveReferences(root, (alias) => (alias === 'My Note' ? ULID : null))

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'embed', documentId: ULID }])
  })

  it('leaves ![[Missing]] as text when the resolver returns null', () => {
    const root = paragraph('![[Missing]]')
    const resolved = resolveReferences(root, () => null)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: '![[Missing]]' }])
  })

  it('resolves a bare [[ULID]] reference nested inside a blockquote', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'blockquote' as const,
          children: [
            {
              type: 'paragraph' as const,
              children: [{ type: 'text' as const, value: `[[${ULID}]]` }],
            },
          ],
        },
      ],
    }
    const resolved = resolveReferences(root)

    const blockquote = resolved.children[0]
    if (blockquote.type !== 'blockquote') throw new Error('expected blockquote')
    const inner = blockquote.children[0]
    if (inner.type !== 'paragraph') throw new Error('expected paragraph')
    expect(inner.children).toEqual([{ type: 'wikiLink', documentId: ULID, alias: undefined }])
  })

  it('resolves a bare [[ULID]] reference nested inside a list item', () => {
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
                  children: [{ type: 'text' as const, value: `[[${ULID}]]` }],
                },
              ],
            },
          ],
        },
      ],
    }
    const resolved = resolveReferences(root)

    const list = resolved.children[0]
    if (list.type !== 'list') throw new Error('expected list')
    const listItem = list.children[0]
    const paragraphNode = listItem.children[0]
    if (paragraphNode.type !== 'paragraph') throw new Error('expected paragraph')
    expect(paragraphNode.children).toEqual([
      { type: 'wikiLink', documentId: ULID, alias: undefined },
    ])
  })

  it('does not hang on a pathological unterminated ![[ + many backslashes', () => {
    const pathological = `![[${'\\'.repeat(50000)}`
    const root = paragraph(pathological)

    const start = performance.now()
    const resolved = resolveReferences(root)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(1000)
    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: pathological }])
  })

  it('does not hang on a pathological unterminated [[ with repeated pipes', () => {
    const pathological = `[[${'a|'.repeat(50000)}`
    const root = paragraph(pathological)

    const start = performance.now()
    const resolved = resolveReferences(root)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(1000)
    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: pathological }])
  })

  it('does not hang on many repeated unterminated [[ (super-linear backtracking trigger)', () => {
    // Each "[[" is its own would-be match start with no closing "]]" anywhere in
    // the string, which is the shape that made the original quantified-class
    // regex super-linear (O(n^2)): every occurrence forced a fresh forward scan
    // to the end of the string looking for a terminator that was never found.
    const pathological = '[['.repeat(16000)
    const root = paragraph(pathological)

    const start = performance.now()
    const resolved = resolveReferences(root)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(1000)
    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: pathological }])
  })

  it('resolves a bare [[ULID]] reference nested inside a table cell', () => {
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
                  children: [{ type: 'text' as const, value: `[[${ULID}]]` }],
                },
              ],
            },
          ],
        },
      ],
    }
    const resolved = resolveReferences(root)

    const table = resolved.children[0]
    if (table.type !== 'table') throw new Error('expected table')
    const row = table.children[0]
    const cell = row.children[0]
    expect(cell.children).toEqual([{ type: 'wikiLink', documentId: ULID, alias: undefined }])
  })
})
