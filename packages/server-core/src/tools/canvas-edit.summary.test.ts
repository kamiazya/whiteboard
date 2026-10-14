// The comment words of `wb_canvas_edit`'s activity summary. The same thread
// plane is written by `wb_thread_edit`, so a person watching the board must
// read the same word for the same act whichever tool the agent reached for.

import { describe, expect, test } from 'vitest'
import type { AgentActivity, CanvasClientNotifier } from '../server-deps.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

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

describe('wb_canvas_edit summary — comment verbs', () => {
  test('a comment.resolve with resolved:false reads as a reopen', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [],
      edges: [],
      comments: [
        { id: 'c1', x: 0, y: 0, text: 'settled', resolved: true },
        { id: 'c2', x: 0, y: 0, text: 'open' },
      ],
    })
    const { activities, notifier } = recordingNotifier()
    const tool = createCanvasEditTool({ ...makeDeps(store), clientNotifier: notifier })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'comment.resolve', id: 'c1', resolved: false },
        { op: 'comment.resolve', id: 'c2' },
        { op: 'comment.add', comment: { x: 1, y: 1, text: 'new' } },
      ],
    })

    expect(activities.map((activity) => activity.summary)).toEqual([
      'commented 1, resolved 1, reopened 1',
    ])
  })
})
