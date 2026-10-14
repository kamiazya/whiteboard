// What a line op of `wb_canvas_edit` announces to a person watching the board.
// The tool's own answer naming the line is not enough: the watcher outlines
// what the NOTIFICATION names, so a line missing there reads as an agent
// editing with nothing outlined.

import { describe, expect, test } from 'vitest'
import type { AgentActivity } from '../server-deps.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

describe('wb_canvas_edit agent activity — lines', () => {
  test('a line.add is announced as a touched line', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [], edges: [] })
    const activities: AgentActivity[] = []
    const tool = createCanvasEditTool({
      ...makeDeps(store),
      clientNotifier: {
        agentActivity: (activity) => {
          activities.push(activity)
        },
        requestViewport: async () => true,
        versionCreated: () => {},
        restoreProgress: () => {},
      },
    })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'line.add',
          line: {
            id: 'l1',
            from: { kind: 'point', point: { x: 10, y: 10 } },
            to: { kind: 'point', point: { x: 90, y: 90 } },
          },
        },
      ],
    })

    expect(activities.map((activity) => activity.touched)).toEqual([
      { nodes: [], edges: [], lines: ['l1'], comments: [] },
    ])
  })
})
