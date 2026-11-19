import { nodeText, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { linkMarkupFor, planLinkifyMentions } from './linkify.js'

const TARGET = { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'redis', name: 'Redis' }

describe('planLinkifyMentions, over plain content', () => {
  it('plans one splice per mention, descending, on the offsets of the body it was given', () => {
    const body = 'Redis and [[redis|Redis]] and Redis'
    const plan = planLinkifyMentions({ kind: 'markdown', body }, TARGET)
    expect(plan.linked).toBe(2)
    expect(plan.edit).toEqual({
      kind: 'markdown-splices',
      runs: [
        { index: 30, remove: 5, insert: linkMarkupFor(TARGET) },
        { index: 0, remove: 5, insert: linkMarkupFor(TARGET) },
      ],
    })
  })

  it('plans no edit when nothing mentions the target', () => {
    expect(planLinkifyMentions({ kind: 'markdown', body: 'nothing' }, TARGET)).toEqual({
      linked: 0,
      edit: null,
    })
  })

  it('plans a canvas as the diff of the canvas it read, rewriting text nodes only', () => {
    const canvas = spatialCanvasSchema.parse({
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'use Redis' }),
        textNode({ id: 'b', x: 0, y: 20, width: 10, height: 10, text: 'plain' }),
      ],
      edges: [],
    })
    const plan = planLinkifyMentions({ kind: 'spatial', canvas }, TARGET)
    expect(plan.linked).toBe(1)
    expect(plan.edit?.kind).toBe('spatial-canvas')
    if (plan.edit?.kind !== 'spatial-canvas') return
    expect(plan.edit.before).toBe(canvas)
    expect(plan.edit.after.nodes.map((n) => nodeText(n))).toEqual(['use [[redis|Redis]]', 'plain'])
  })
})
