import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { ListBlockNode, SceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { firstLineOfBlocks, typesetMdastBlocks } from './mdast-blocks.js'

/**
 * Keep-first for a body whose FIRST block is a list: a node too small for
 * even one line keeps the list's first item only. Keeping the whole list
 * would paint every other item past the node's border, and calling a list
 * with nothing beyond its first item truncated would draw an ellipsis over
 * content that is all there.
 */

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

function bulletList(...items: readonly string[]): MdastRoot {
  return {
    type: 'root',
    children: [
      {
        type: 'list',
        ordered: false,
        children: items.map((value) => ({
          type: 'listItem' as const,
          children: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, value }] }],
        })),
      },
    ],
  }
}

function onlyList(nodes: readonly SceneNode[]): ListBlockNode {
  expect(nodes).toHaveLength(1)
  const [list] = nodes
  if (list?.kind !== 'list') throw new Error(`expected a list, got ${list?.kind}`)
  return list
}

function runsUnder(node: SceneNode): readonly TextRunNode[] {
  if (node.kind === 'textRun') return [node]
  if (node.kind === 'list') return node.items.flatMap((item) => item.children.flatMap(runsUnder))
  if (node.kind === 'paragraph' || node.kind === 'heading') return node.runs
  return []
}

describe('firstLineOfBlocks — a body that starts with a list', () => {
  it('keeps only the first item of a three-item list and marks it truncated', () => {
    const scene = typesetMdastBlocks(bulletList('alpha', 'beta', 'gamma'), options)
    expect(onlyList(scene.nodes).items).toHaveLength(3)

    const fitted = firstLineOfBlocks(scene.nodes)

    const list = onlyList(fitted.nodes)
    expect(list.items).toHaveLength(1)
    expect(runsUnder(list).map((run) => run.text)).toEqual(['•', 'alpha'])
    expect(fitted.truncated).toBe(true)
    expect(runsUnder(list).at(-1)?.truncated).toBe(true)
  })

  it('does not call a one-item list truncated', () => {
    const scene = typesetMdastBlocks(bulletList('alpha'), options)

    const fitted = firstLineOfBlocks(scene.nodes)

    expect(onlyList(fitted.nodes).items).toHaveLength(1)
    expect(fitted.truncated).toBe(false)
    expect(runsUnder(fitted.nodes[0] as SceneNode).some((run) => run.truncated === true)).toBe(
      false,
    )
  })
})
