/**
 * `wb_thread_edit` on a board a person may be watching: a thread opened,
 * answered or closed there is announced the way the same act through
 * `wb_canvas_edit` is, so the "Agent editing" chip and the comment outline
 * do not depend on which tool the agent reached for.
 */
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, onTestFinished, test } from 'vitest'
import { setLogSink } from '../log.js'
import type { AgentActivity, CanvasClientNotifier, ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createThreadEditTool } from './thread-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

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

async function seededDeps(
  kind: 'spatial' | 'markdown',
  notifier: CanvasClientNotifier,
): Promise<ServerDeps> {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, kind)
    if (kind === 'spatial') {
      writeSpatialCanvas(doc, {
        nodes: [textNode({ id: 'a', x: 0, y: 0, width: 200, height: 60, text: 'Alpha' })],
        edges: [],
      })
    } else {
      writeMarkdownBody(doc, 'a note with a passage')
    }
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind,
  })
  return makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    clientNotifier: notifier,
  })
}

const SPOT = { kind: 'spatial', nodeId: 'a', x: 10, y: 10 } as const
const EMPTY_TOUCHED = { nodes: [], edges: [], lines: [], comments: [] }

describe('wb_thread_edit — telling a watching browser', () => {
  test('a thread opened on a board is announced with its id', async () => {
    const { activities, notifier } = recordingNotifier()
    const tool = createThreadEditTool(await seededDeps('spatial', notifier))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.add', anchor: SPOT, body: 'why?' }],
    })

    expect(activities).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        touched: { ...EMPTY_TOUCHED, comments: ['t1'] },
        summary: 'commented 1',
      },
    ])
  })

  test('a reply and a resolve name the thread they reached', async () => {
    const { activities, notifier } = recordingNotifier()
    const tool = createThreadEditTool(await seededDeps('spatial', notifier))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        { op: 'thread.add', threadId: 'q', anchor: SPOT, body: 'one' },
        { op: 'thread.add', threadId: 'r', anchor: SPOT, body: 'two' },
      ],
    })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        { op: 'message.add', threadId: 'r', body: 'answered' },
        { op: 'thread.resolve', threadId: 'q' },
      ],
    })

    expect(activities).toHaveLength(2)
    expect(activities[1]?.touched).toEqual({ ...EMPTY_TOUCHED, comments: ['q', 'r'] })
    expect(activities[1]?.summary).toBe('replied 1, resolved 1')
  })

  test('a markdown note announces nothing, having no presence surface', async () => {
    const { activities, notifier } = recordingNotifier()
    const tool = createThreadEditTool(await seededDeps('markdown', notifier))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.add', anchor: { kind: 'document' }, body: 'overall: good' }],
    })

    expect(result.threads).toHaveLength(1)
    expect(activities).toEqual([])
  })

  test('a notifier that throws does not fail the write that already landed', async () => {
    const warned: unknown[] = []
    setLogSink((record) => {
      if (record.level === 'warning') warned.push(record.data?.notification)
    })
    onTestFinished(() => setLogSink(() => {}))
    const notifier: CanvasClientNotifier = {
      ...recordingNotifier().notifier,
      agentActivity: () => {
        throw new Error('socket exploded')
      },
    }
    const tool = createThreadEditTool(await seededDeps('spatial', notifier))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.add', anchor: SPOT, body: 'why?' }],
    })

    expect(result.threads.map((thread) => thread.id)).toEqual(['t1'])
    expect(warned).toEqual(['agentActivity'])
  })
})
