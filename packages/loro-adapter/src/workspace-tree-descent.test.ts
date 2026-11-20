import { type ContainerID, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { containerPlace } from './container-place.js'
import { openMergeableMap } from './mergeable-containers.js'
import { descendsFromWorkspaceTree } from './workspace-tree-descent.js'

function recordWithOneNode() {
  const doc = new LoroDoc()
  const node = doc.getTree('tree').createNode()
  node.data.set('documentId', 'd1')
  const child = openMergeableMap(node.data, 'threads')
  child.set('a', 1)
  const side = openMergeableMap(doc.getMap('side'), 'kid')
  side.set('x', 1)
  doc.commit()
  return { doc, node, child, side }
}

const ABSENT_ROOTS = [
  'cid:root-body:Text',
  'cid:root-zzz:Map',
  'cid:root-tree:Map',
] as ContainerID[]

describe('descendsFromWorkspaceTree', () => {
  it('answers false for a root the record lacks and registers no container for it', () => {
    const { doc } = recordWithOneNode()
    const before = doc.getShallowValue()

    for (const root of ABSENT_ROOTS) expect(descendsFromWorkspaceTree(doc, root)).toBe(false)

    expect(doc.getShallowValue()).toEqual(before)
  })

  it('still places a mergeable child by its parent chain, below the tree and beside it', () => {
    const { doc, node, child, side } = recordWithOneNode()

    expect(descendsFromWorkspaceTree(doc, child.id)).toBe(true)
    expect(descendsFromWorkspaceTree(doc, node.data.id)).toBe(true)
    expect(descendsFromWorkspaceTree(doc, side.id)).toBe(false)
    expect(descendsFromWorkspaceTree(doc, 'cid:root-tree:Tree' as ContainerID)).toBe(true)
  })

  it('reads a mergeable child id as the marked root id the shortcut leaves to the parent walk', () => {
    const { child, side } = recordWithOneNode()

    expect(child.id.startsWith('cid:root-🤝:')).toBe(true)
    expect(side.id.startsWith('cid:root-🤝:')).toBe(true)
  })
})

describe('containerPlace', () => {
  it('answers null for a root the record lacks and registers no container for it', () => {
    const { doc } = recordWithOneNode()
    const before = doc.getShallowValue()

    for (const root of ABSENT_ROOTS) expect(containerPlace(doc, root)).toBeNull()

    expect(doc.getShallowValue()).toEqual(before)
  })
})
