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
  it('resolves [[canvas:ULID]] directly with no resolver needed', () => {
    const root = paragraph(`see [[canvas:${ULID}]] here`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'wikiLink', canvasId: ULID, alias: undefined },
      { type: 'text', value: ' here' },
    ])
  })

  it('resolves [[alias]] to a wikiLink when the resolver returns non-null', () => {
    const root = paragraph('[[My Note]]')
    const resolved = resolveReferences(root, (alias) => (alias === 'My Note' ? ULID : null))

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'wikiLink', canvasId: ULID, alias: 'My Note' }])
  })

  it('leaves [[alias]] as text when the resolver returns null', () => {
    const root = paragraph('[[Missing]]')
    const resolved = resolveReferences(root, () => null)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: '[[Missing]]' }])
  })

  it('leaves a malformed canvas: reference as text', () => {
    const root = paragraph('[[canvas:not-a-ulid]]')
    const resolved = resolveReferences(root, () => ULID)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: '[[canvas:not-a-ulid]]' }])
  })

  it('with no resolver, only [[canvas:ULID]] parses — [[alias]] stays text', () => {
    const root = paragraph(`[[canvas:${ULID}]] and [[alias]]`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([
      { type: 'wikiLink', canvasId: ULID, alias: undefined },
      { type: 'text', value: ' and ' },
      { type: 'text', value: '[[alias]]' },
    ])
  })

  it('supports an explicit alias override: [[canvas:ULID|Display Name]]', () => {
    const root = paragraph(`[[canvas:${ULID}|Display Name]]`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'wikiLink', canvasId: ULID, alias: 'Display Name' }])
  })

  it('resolves ![[canvas:ULID]] to an embed node, not a wikiLink', () => {
    const root = paragraph(`![[canvas:${ULID}]]`)
    const resolved = resolveReferences(root)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'embed', canvasId: ULID }])
  })

  it('resolves ![[alias]] to an embed node through the resolver', () => {
    const root = paragraph('![[My Note]]')
    const resolved = resolveReferences(root, (alias) => (alias === 'My Note' ? ULID : null))

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'embed', canvasId: ULID }])
  })

  it('leaves ![[Missing]] as text when the resolver returns null', () => {
    const root = paragraph('![[Missing]]')
    const resolved = resolveReferences(root, () => null)

    const children = resolved.children[0]
    if (children.type !== 'paragraph') throw new Error('expected paragraph')
    expect(children.children).toEqual([{ type: 'text', value: '![[Missing]]' }])
  })

  it('resolves a [[canvas:ULID]] reference nested inside a blockquote', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'blockquote' as const,
          children: [
            {
              type: 'paragraph' as const,
              children: [{ type: 'text' as const, value: `[[canvas:${ULID}]]` }],
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
    expect(inner.children).toEqual([{ type: 'wikiLink', canvasId: ULID, alias: undefined }])
  })

  it('resolves a [[canvas:ULID]] reference nested inside a list item', () => {
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
                  children: [{ type: 'text' as const, value: `[[canvas:${ULID}]]` }],
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
    expect(paragraphNode.children).toEqual([{ type: 'wikiLink', canvasId: ULID, alias: undefined }])
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

  it('resolves a [[canvas:ULID]] reference nested inside a table cell', () => {
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
                  children: [{ type: 'text' as const, value: `[[canvas:${ULID}]]` }],
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
    expect(cell.children).toEqual([{ type: 'wikiLink', canvasId: ULID, alias: undefined }])
  })
})
