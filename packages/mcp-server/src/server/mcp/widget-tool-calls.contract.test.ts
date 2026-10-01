// The MCP Apps widget's outbound calls are built by canvas-viewer, which cannot
// import server-core, so no compiler sees the two ends together. This is the one
// place they meet: the exact arguments the widget sends, parsed by the schemas
// the server registers for those tools.
import {
  canvasViewCall,
  commentAddCall,
} from '@kamiazya/whiteboard-canvas-viewer/widget-tool-calls'
import { canvasEditInputSchema, canvasViewInputSchema } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'

const target = {
  workspaceId: '01JZ0000000000000000000001',
  documentId: '01JZ0000000000000000000002',
}

describe("the widget's outbound tool calls against the server's input schemas", () => {
  it('canvas_view refresh is accepted by canvas_view', () => {
    const call = canvasViewCall(target)
    expect(call.name).toBe('canvas_view')
    expect(canvasViewInputSchema.safeParse(call.arguments).success).toBe(true)
  })

  it('a comment pinned on a point is accepted by wb_canvas_edit', () => {
    const call = commentAddCall(target, { x: 12, y: 34 }, 'move this')
    expect(call.name).toBe('wb_canvas_edit')
    const parsed = canvasEditInputSchema.safeParse(call.arguments)
    expect(parsed.error?.issues).toBeUndefined()
    expect(parsed.success).toBe(true)
  })

  it('a comment pinned on a node carries both the point and the target', () => {
    const call = commentAddCall(target, { x: 12, y: 34, targetNodeId: 'n1' }, 'rename')
    const parsed = canvasEditInputSchema.parse(call.arguments)
    expect(parsed.ops[0]).toMatchObject({
      op: 'comment.add',
      comment: { x: 12, y: 34, targetNodeId: 'n1', text: 'rename' },
    })
  })

  it('the wb_canvas_edit schema refuses a comment with no text, so a dropped field is visible here', () => {
    const call = commentAddCall(target, { x: 1, y: 2 }, 'ok')
    const comment = call.arguments.ops[0].comment
    const { text: _text, ...withoutText } = comment
    const broken = { ...call.arguments, ops: [{ op: 'comment.add', comment: withoutText }] }
    expect(canvasEditInputSchema.safeParse(broken).success).toBe(false)
  })
})
