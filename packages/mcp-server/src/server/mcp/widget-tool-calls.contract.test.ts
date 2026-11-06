// The MCP Apps widget's outbound calls are built by canvas-viewer, which cannot
// import server-core, so no compiler sees the two ends together. This is the one
// place they meet: the exact arguments the widget sends, parsed by the schemas
// the server registers for those tools.
import { canvasViewCall, threadAddCall } from '@kamiazya/whiteboard-canvas-viewer/widget-tool-calls'
import {
  canvasViewInputSchema,
  threadEditInputSchema,
} from '@kamiazya/whiteboard-server-core/test-utils/tools'
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

  it('canvas_view refresh repeats the style a result echoed, and the server accepts it', () => {
    const call = canvasViewCall({ ...target, style: 'document' })
    expect(call.arguments).toEqual({ ...target, style: 'document' })
    expect(canvasViewInputSchema.safeParse(call.arguments).success).toBe(true)
  })

  it('canvas_view refresh sends no style key when the result echoed none', () => {
    expect(canvasViewCall(target).arguments).toEqual(target)
  })

  it('a comment pinned on a point is accepted by wb_thread_edit', () => {
    const call = threadAddCall(target, { x: 12, y: 34 }, 'move this')
    expect(call.name).toBe('wb_thread_edit')
    const parsed = threadEditInputSchema.safeParse(call.arguments)
    expect(parsed.error?.issues).toBeUndefined()
    expect(parsed.success).toBe(true)
  })

  it('a comment pinned on a node carries both the point and the node', () => {
    const call = threadAddCall(target, { x: 12, y: 34, targetNodeId: 'n1' }, 'rename')
    const parsed = threadEditInputSchema.parse(call.arguments)
    expect(parsed.ops[0]).toMatchObject({
      op: 'thread.add',
      anchor: { kind: 'spatial', x: 12, y: 34, nodeId: 'n1' },
      body: 'rename',
    })
  })

  it('the wb_thread_edit schema refuses a thread with no body, so a dropped field is visible here', () => {
    const call = threadAddCall(target, { x: 1, y: 2 }, 'ok')
    const { body: _body, ...withoutBody } = call.arguments.ops[0]
    const broken = { ...call.arguments, ops: [withoutBody] }
    expect(threadEditInputSchema.safeParse(broken).success).toBe(false)
  })
})
