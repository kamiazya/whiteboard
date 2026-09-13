import { describe, expect, it } from 'vitest'
import { spatialNodeSchema } from '../spatial.js'
import { fileNode, groupNode, linkNode, textNode } from './nodes.js'

describe('node builders', () => {
  it('builds a text node the model accepts, from semantic fields only', () => {
    const node = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hello' })
    expect(spatialNodeSchema.parse(node)).toEqual(node)
    expect(node).toMatchObject({ id: 'a', text: 'hello' })
  })

  it('builds the other three arms', () => {
    const file = fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'notes.md' })
    const link = linkNode({
      id: 'l',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      url: 'https://example.com',
    })
    const group = groupNode({ id: 'g', x: 0, y: 0, width: 10, height: 10, label: 'Tier' })
    for (const node of [file, link, group]) expect(spatialNodeSchema.parse(node)).toEqual(node)
  })

  it('carries the fields a caller adds, and omits the ones it does not', () => {
    const node = textNode({ id: 'a', x: 1, y: 2, width: 3, height: 4, text: '', color: '3' })
    expect(spatialNodeSchema.parse(node)).toEqual(node)
    expect(node).not.toHaveProperty('embed')
    expect(node).not.toHaveProperty('facets')
  })

  /**
   * The pin the module header promises: a builder's input names what a node
   * MEANS, never how the model stores it. `type` is the stored discriminant
   * that ADR-0038 decision 3 dissolves, so accepting it here would let a
   * fixture spell the very thing the builders exist to hide — and the
   * migration would have to be done twice. `@ts-expect-error` fails the
   * typecheck in BOTH directions: if the input ever widens to admit `type`,
   * the directive becomes unused and the build breaks.
   */
  it('refuses the stored discriminant as an input', () => {
    // @ts-expect-error `type` is stored, not meant
    const node = textNode({ id: 'a', x: 0, y: 0, width: 1, height: 1, text: '', type: 'text' })
    expect(spatialNodeSchema.parse(node)).toEqual(node)
  })
})
