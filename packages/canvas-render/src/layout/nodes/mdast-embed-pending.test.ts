import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { typesetMdastBlocks } from './mdast-blocks.js'

const measure = createFakeMeasure()
const options = { measure, maxWidth: 600, fontFamily: 'sans-serif' }

describe('typesetMdastBlocks — an embed whose target is still loading', () => {
  const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  type Flow = MdastRoot['children'][number]
  const embedPara = (documentId: string): Flow => ({
    type: 'paragraph',
    children: [{ type: 'embed', documentId }],
  })
  const rootOf = (children: Flow[]): MdastRoot => ({ type: 'root', children })
  const pending = { ...options, resolveEmbed: () => undefined, isEmbedPending: () => true }

  it('draws a frame with its label and a Loading line instead of plain link text', () => {
    const scene = typesetMdastBlocks(rootOf([embedPara(A)]), {
      ...pending,
      resolveTitle: () => 'Board',
    })
    const embed = scene.nodes[0]
    if (embed?.kind !== 'embedResolved') throw new Error('expected a framed pending embed')
    expect(embed.documentId).toBe(A)
    expect(embed.children[0]?.kind).toBe('shape')
    const texts = embed.children.flatMap((n) => (n.kind === 'textRun' ? [n.text] : []))
    expect(texts.join('')).toContain('Board')
    expect(texts).toContain('Loading…')
  })

  it('keeps the unresolvable placeholder once the target is no longer pending', () => {
    const scene = typesetMdastBlocks(rootOf([embedPara(A)]), {
      ...pending,
      isEmbedPending: () => false,
    })
    const node = scene.nodes[0]
    if (node?.kind !== 'embedPlaceholder') throw new Error('expected placeholder')
    expect(node.reason).toBe('unresolvable')
  })

  it('advances the cursor past the frame so the next block does not overlap it', () => {
    const scene = typesetMdastBlocks(
      rootOf([embedPara(A), { type: 'paragraph', children: [{ type: 'text', value: 'after' }] }]),
      pending,
    )
    const [embed, after] = scene.nodes
    if (embed?.kind !== 'embedResolved' || after?.kind !== 'paragraph') throw new Error('shape')
    expect(after.bbox.y).toBeGreaterThanOrEqual(embed.bbox.y + embed.bbox.h)
  })
})
