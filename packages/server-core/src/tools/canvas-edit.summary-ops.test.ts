// The tallies of `wb_canvas_edit`'s activity summary for the edge and line
// verbs, and the line a batch of only silent ops reads as. The summary is
// what a person watching the board reads in the agent toast, so a verb that
// drops out of it changes what they are told while every op still applies.

import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import type { AgentActivity, CanvasClientNotifier } from '../server-deps.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import type { CanvasEditInput } from './canvas-edit-ops.js'

function recordingNotifier(): {
  readonly activities: AgentActivity[]
  readonly notifier: CanvasClientNotifier
} {
  const activities: AgentActivity[] = []
  return {
    activities,
    notifier: {
      agentActivity: (activity) => {
        activities.push(activity)
      },
      requestViewport: async () => true,
      versionCreated: () => {},
      restoreProgress: () => {},
    },
  }
}

const point = (x: number, y: number) => ({ kind: 'point' as const, point: { x, y } })

async function summaryOf(ops: CanvasEditInput['ops']): Promise<readonly string[]> {
  const store = new FakeDocumentStore()
  await seedCanvas(store, {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'one\ntwo' }),
      textNode({ id: 'b', x: 300, y: 0, width: 100, height: 60, text: 'b' }),
    ],
    edges: [
      { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
      { id: 'e2', from: { node: 'b' }, to: { node: 'a' } },
    ],
    lines: [
      { id: 'l1', from: point(0, 200), to: point(100, 200) },
      { id: 'l2', from: point(0, 300), to: point(100, 300) },
    ],
  })
  const { activities, notifier } = recordingNotifier()
  const tool = createCanvasEditTool({ ...makeDeps(store), clientNotifier: notifier })
  await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, mode: 'apply', ops })
  return activities.map((activity) => activity.summary)
}

describe('wb_canvas_edit summary — edge and line verbs', () => {
  test('edge and line adds, patches and removes are each tallied', async () => {
    const summaries = await summaryOf([
      { op: 'edge.add', edge: { id: 'e3', from: { node: 'a' }, to: { node: 'b' } } },
      { op: 'line.add', line: { id: 'l3', from: point(0, 400), to: point(100, 400) } },
      { op: 'edge.patch', id: 'e1', patch: { label: 'calls' } },
      { op: 'line.patch', id: 'l1', patch: { label: 'underline' } },
      { op: 'edge.remove', id: 'e2' },
      { op: 'line.remove', id: 'l2' },
    ])

    expect(summaries).toEqual(['added 2, changed 2, removed 2'])
  })

  test('a batch of only node.splice reads as an unspecific edit', async () => {
    const summaries = await summaryOf([
      { op: 'node.splice', id: 'a', startLine: 0, endLine: 0, replacement: 'first' },
    ])

    expect(summaries).toEqual(['edited the canvas'])
  })
})
