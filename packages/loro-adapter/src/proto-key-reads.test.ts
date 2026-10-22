/**
 * A Loro map entry keyed `__proto__` does not come back from `toJSON()` as an
 * own key: the projection assigns it, which REPLACES the object's prototype
 * with the entry's value. Nothing is polluted globally, but `key in obj` then
 * answers for keys the map does not hold. Every reader of content keys here
 * judges own keys only, so such an entry can neither lend a document content
 * it does not have nor survive a clear.
 */
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { contentDigestOfDocument } from './content-digest.js'
import { clearRootContainer, jsonEqual } from './content-sync.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  reconcileDocContent,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const ID = '01JQXYZ0000000000000000000'
const NODE = { id: 'n1', type: 'text', text: 'inherited', x: 0, y: 0, width: 10, height: 10 }

/** A document whose only root is a map named `__proto__` holding a `nodes` entry. */
function protoRooted(): LoroDoc {
  const doc = new LoroDoc()
  doc.getMap('__proto__').setContainer('nodes', new LoroMap()).set('n1', NODE)
  doc.commit()
  return doc
}

function withNodes(doc: LoroDoc): LoroDoc {
  doc.getMap('nodes').set('n1', NODE)
  doc.commit()
  return doc
}

describe('a `__proto__` root or entry read through toJSON()', () => {
  it('lends no content to the content digest', () => {
    const doc = protoRooted()
    // Precondition: the projection really does inherit through the planted root.
    expect('nodes' in (doc.toJSON() as object)).toBe(true)

    expect(contentDigestOfDocument(doc)).toBe(contentDigestOfDocument(new LoroDoc()))
  })

  it('does not stop a tree write clearing a root the source lacks', () => {
    const ws = new LoroDoc()
    createWorkspaceDocumentAtPath(ws, { path: 'a', documentId: ID, kind: 'spatial' })
    writeWorkspaceDocumentContent(ws, ID, withNodes(new LoroDoc()))
    expect(documentContainers(ws, ID).getMap('nodes').size).toBe(1)

    writeWorkspaceDocumentContent(ws, ID, protoRooted())

    expect(documentContainers(ws, ID).getMap('nodes').size).toBe(0)
  })

  it('does not stop a restore clearing a root the past lacks', () => {
    const live = withNodes(new LoroDoc())

    reconcileDocContent(live, protoRooted())

    expect(live.getMap('nodes').size).toBe(0)
  })

  it('is removed by a clear of its map', () => {
    const doc = new LoroDoc()
    const map = doc.getMap('nodes')
    map.set('__proto__', NODE)
    map.set('n2', NODE)

    const roots = { map: (key: string) => doc.getMap(key) } as Parameters<
      typeof clearRootContainer
    >[0]
    expect(clearRootContainer(roots, 'nodes', 'map')).toBe(true)

    expect(map.keys()).toEqual([])
  })

  it('makes no value equal one holding a key it only inherits', () => {
    const inheriting = JSON.parse('{"b":1}') as Record<string, unknown>
    Object.setPrototypeOf(inheriting, { a: 1 })

    expect(jsonEqual({ a: 1 }, inheriting)).toBe(false)
  })
})
