import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/internal'
import { LoroDoc } from 'loro-crdt'
import type { CanvasIndexInput } from '../derive-index.js'
import { WorkspaceTree } from '../workspace-tree.js'

export const NOTES_ID = '01J0000000000000000000000A'
export const PROJECT_ID = '01J0000000000000000000000B'
export const DIAGRAM_ID = '01J0000000000000000000000C'

/**
 * Small fixture workspace: a root `notes` canvas (tagged, wikilinks the
 * nested project doc), a `projects/whiteboard` canvas (has an extension
 * facet + embeds the diagram), and a `projects/diagram` spatial canvas with
 * no body to extract links from.
 */
export function buildFixtureWorkspace(): {
  tree: WorkspaceTree
  canvases: readonly CanvasIndexInput[]
} {
  const doc = new LoroDoc()
  const tree = new WorkspaceTree(doc)

  tree.createNode(NOTES_ID, 'notes')
  const projectsId = tree.createNode('01J0000000000000000000000D', 'projects')
  tree.createNode(PROJECT_ID, 'whiteboard', projectsId)
  tree.createNode(DIAGRAM_ID, 'diagram', projectsId)

  const notesBody: MdastRoot = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'See ' },
          { type: 'wikiLink', canvasId: PROJECT_ID, alias: 'whiteboard' },
          { type: 'text', value: '.' },
        ],
      },
    ],
  }

  const projectBody: MdastRoot = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'embed', canvasId: DIAGRAM_ID }],
      },
    ],
  }

  const canvases: readonly CanvasIndexInput[] = [
    {
      canvasId: NOTES_ID,
      updatedAtMs: 1_000,
      coreFacets: { type: 'doc', tags: ['inbox', 'urgent'] },
      resolvedBody: notesBody,
    },
    {
      canvasId: PROJECT_ID,
      updatedAtMs: 2_000,
      coreFacets: { type: 'doc', title: 'Whiteboard Project' },
      extensionFacets: { 'kanban/1': { columns: ['todo', 'done'] } },
      resolvedBody: projectBody,
    },
    {
      canvasId: DIAGRAM_ID,
      updatedAtMs: 3_000,
      coreFacets: { type: 'spatial' },
    },
  ]

  return { tree, canvases }
}
