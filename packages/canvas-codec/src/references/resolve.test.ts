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
})
