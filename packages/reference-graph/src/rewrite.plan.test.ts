import { spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { planDocumentReferenceRewrite } from './rewrite.js'

const PLAN = new Map([['old', 'new']])

describe('planDocumentReferenceRewrite, over plain content', () => {
  it('plans a markdown body as its rewritten body', () => {
    expect(planDocumentReferenceRewrite({ kind: 'markdown', body: 'see [[old]]' }, PLAN)).toEqual({
      kind: 'markdown-body',
      body: 'see [[new]]',
    })
  })

  it('plans nothing for a body that names no planned alias', () => {
    expect(
      planDocumentReferenceRewrite({ kind: 'markdown', body: 'see [[else]]' }, PLAN),
    ).toBeNull()
  })

  it('plans only the nodes whose references moved', () => {
    const canvas = spatialCanvasSchema.parse({
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'see [[old]]' }),
        textNode({ id: 'b', x: 0, y: 20, width: 10, height: 10, text: 'untouched' }),
      ],
      edges: [],
    })
    const edit = planDocumentReferenceRewrite({ kind: 'spatial', canvas }, PLAN)
    expect(edit?.kind).toBe('spatial-nodes')
    if (edit?.kind !== 'spatial-nodes') return
    expect(edit.nodes.map((n) => n.id)).toEqual(['a'])
  })
})
