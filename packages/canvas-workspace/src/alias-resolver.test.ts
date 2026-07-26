import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { resolveReferences } from '@kamiazya/whiteboard-canvas-codec'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/internal'
import { createAliasResolver } from './alias-resolver.js'
import { WorkspaceTree } from './workspace-tree.js'

function makeTree(): { tree: WorkspaceTree; doc: LoroDoc } {
  const doc = new LoroDoc()
  return { doc, tree: new WorkspaceTree(doc) }
}

describe('createAliasResolver', () => {
  test('resolves a root-level alias to its canvasId', () => {
    const { tree } = makeTree()
    tree.createNode('01J0000000000000000000000A', 'notes')

    const resolver = createAliasResolver(tree)
    expect(resolver('notes')).toBe('01J0000000000000000000000A')
  })

  test('resolves a nested alias path', () => {
    const { tree } = makeTree()
    const parent = tree.createNode('01J0000000000000000000000A', 'projects')
    tree.createNode('01J0000000000000000000000B', 'whiteboard', parent)

    const resolver = createAliasResolver(tree)
    expect(resolver('projects/whiteboard')).toBe('01J0000000000000000000000B')
  })

  test('returns null for unknown alias', () => {
    const { tree } = makeTree()
    const resolver = createAliasResolver(tree)
    expect(resolver('nonexistent')).toBeNull()
  })

  test('integrates with resolveReferences from canvas-codec', () => {
    const { tree } = makeTree()
    tree.createNode('01J0000000000000000000000A', 'notes')

    const resolver = createAliasResolver(tree)
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'See [[notes]] for details.' }],
        },
      ],
    }

    const resolved = resolveReferences(root, resolver)
    const para = resolved.children[0]
    expect(para.type).toBe('paragraph')
    if (para.type === 'paragraph') {
      expect(para.children).toHaveLength(3)
      expect(para.children[0]).toEqual({ type: 'text', value: 'See ' })
      expect(para.children[1]).toEqual({
        type: 'wikiLink',
        canvasId: '01J0000000000000000000000A',
        alias: 'notes',
      })
      expect(para.children[2]).toEqual({ type: 'text', value: ' for details.' })
    }
  })

  test('integrates embed syntax ![[alias]]', () => {
    const { tree } = makeTree()
    tree.createNode('01J0000000000000000000000A', 'diagram')

    const resolver = createAliasResolver(tree)
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: '![[diagram]]' }],
        },
      ],
    }

    const resolved = resolveReferences(root, resolver)
    const para = resolved.children[0]
    if (para.type === 'paragraph') {
      expect(para.children).toEqual([{ type: 'embed', canvasId: '01J0000000000000000000000A' }])
    }
  })
})
