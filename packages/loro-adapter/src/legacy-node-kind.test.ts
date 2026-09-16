import { LoroDoc } from 'loro-crdt'
import {
  isFrame,
  nodeFile,
  nodeKind,
  nodeSubpath,
  nodeText,
  nodeUrl,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { readSpatialCanvas } from './loro-bridge.js'

/**
 * A record written before [ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 3 stored a node's content as a KIND plus that kind's own field —
 * `{ type: 'text', text }`, `{ type: 'file', file, subpath? }`,
 * `{ type: 'link', url }`, `{ type: 'group', label? }` — because the model was
 * the format. The literals below are the shape as it stood, the way a
 * migration's own text always is.
 *
 * Nothing else would say so. `spatialNodeSchema` is `.strict()` and names none
 * of those fields, so a stored node still carrying them fails its schema and
 * `readSpatialCanvas` drops what fails: the node VANISHES rather than losing
 * its content, and every other test in this package asserts on a document this
 * version wrote.
 */
function docWithLegacyNodeKinds(): LoroDoc {
  const doc = new LoroDoc()
  const nodes = doc.getMap('nodes')
  const box = { x: 0, y: 0, width: 10, height: 10 }
  nodes.set('n-text', { id: 'n-text', type: 'text', text: 'hi', ...box })
  nodes.set('n-file', {
    id: 'n-file',
    type: 'file',
    file: 'notes/a.md',
    subpath: '#heading',
    ...box,
  })
  nodes.set('n-link', { id: 'n-link', type: 'link', url: 'https://example.com', ...box })
  nodes.set('n-group', {
    id: 'n-group',
    type: 'group',
    label: 'Cluster',
    background: 'bg.png',
    backgroundStyle: 'cover',
    ...box,
  })
  return doc
}

describe('a record written under the pre-ADR-0038 node-kind union still reads', () => {
  const canvas = readSpatialCanvas(docWithLegacyNodeKinds() as never)
  const byId = (id: string) => canvas.nodes.find((node) => node.id === id)

  it('keeps every node rather than dropping the ones carrying the old fields', () => {
    expect(canvas.nodes.map((node) => node.id).sort()).toEqual([
      'n-file',
      'n-group',
      'n-link',
      'n-text',
    ])
  })

  it('lifts a text node into the resource it shows', () => {
    const node = byId('n-text')
    expect(node && nodeKind(node)).toBe('text')
    expect(node && nodeText(node)).toBe('hi')
  })

  it('lifts a file node, keeping the fragment inside it', () => {
    const node = byId('n-file')
    expect(node && nodeKind(node)).toBe('file')
    expect(node && nodeFile(node)).toBe('notes/a.md')
    expect(node && nodeSubpath(node)).toBe('#heading')
  })

  it('lifts a link node into a resource whose location is the address', () => {
    const node = byId('n-link')
    expect(node && nodeKind(node)).toBe('link')
    expect(node && nodeUrl(node)).toBe('https://example.com')
  })

  it('lifts a group into the frame it always was, keeping its own fields', () => {
    const node = byId('n-group')
    expect(node && isFrame(node)).toBe(true)
    expect(node?.label).toBe('Cluster')
    expect(node?.background).toBe('bg.png')
    expect(node?.backgroundStyle).toBe('cover')
  })
})
