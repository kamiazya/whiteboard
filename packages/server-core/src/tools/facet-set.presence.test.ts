/**
 * `wb_facet_set` on a board a person may be watching: restyling or tagging a
 * node, an edge or the canvas is announced the way the same change through
 * `wb_canvas_edit`'s `node.patch` is, so the chip and the outline say an
 * agent did it whichever tool it used.
 */
import {
  writeCoreFacets,
  writeDocumentKind,
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
import { createFacetSetTool } from './facet-set.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const EMPTY_TOUCHED = { nodes: [], edges: [], lines: [], comments: [] }

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
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, kind)
    if (kind === 'spatial') {
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({ id: 'a', x: 0, y: 0, width: 200, height: 60, text: 'A' }),
          textNode({ id: 'b', x: 300, y: 0, width: 200, height: 60, text: 'B' }),
        ],
        edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
      })
    } else {
      writeCoreFacets(doc, { type: 'note', tags: [] })
    }
  })
  return makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    clientNotifier: notifier,
  })
}

describe('wb_facet_set — telling a watching browser', () => {
  test('a node write names the node', async () => {
    const { activities, notifier } = recordingNotifier()
    const tool = createFacetSetTool(await seededDeps('spatial', notifier))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      nodeId: 'a',
      tags: { add: ['reviewed'] },
    })

    expect(activities).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        touched: { ...EMPTY_TOUCHED, nodes: ['a'] },
        summary: 'changed 1',
      },
    ])
  })

  test('an edge write names the edge', async () => {
    const { activities, notifier } = recordingNotifier()
    const tool = createFacetSetTool(await seededDeps('spatial', notifier))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      edgeId: 'e1',
      tags: { add: ['reviewed'] },
    })

    expect(activities.map((activity) => activity.touched)).toEqual([
      { ...EMPTY_TOUCHED, edges: ['e1'] },
    ])
  })

  // A theme or a board's tags is no one element: the chip says an agent is
  // at work, and nothing is outlined, since outlining every node would claim
  // each one was edited.
  test('a canvas write is announced with nothing outlined', async () => {
    const { activities, notifier } = recordingNotifier()
    const tool = createFacetSetTool(await seededDeps('spatial', notifier))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      target: 'canvas',
      tags: { add: ['reviewed'] },
    })

    expect(activities).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        touched: EMPTY_TOUCHED,
        summary: 'changed the canvas',
      },
    ])
  })

  test('a markdown note announces nothing, having no presence surface', async () => {
    const { activities, notifier } = recordingNotifier()
    const tool = createFacetSetTool(await seededDeps('markdown', notifier))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: { add: ['reviewed'] },
    })

    expect(result.updated[0]?.tags).toEqual(['reviewed'])
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
    const tool = createFacetSetTool(await seededDeps('spatial', notifier))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      nodeId: 'a',
      tags: { add: ['reviewed'] },
    })

    expect(result.updated[0]?.tags).toEqual(['reviewed'])
    expect(warned).toEqual(['agentActivity'])
  })
})
