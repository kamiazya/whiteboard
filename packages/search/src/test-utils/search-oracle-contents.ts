import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SearchableContent } from '../searchable-texts.js'

const box = { x: 0, y: 0, width: 100, height: 40 }

const canvas = (
  nodes: SpatialCanvas['nodes'],
  edges: SpatialCanvas['edges'] = [],
): SpatialCanvas => ({
  nodes,
  edges,
})

/** The contents `searchableTexts` is recorded over: every node kind, label and description shape. */
export function searchableContents(): SearchableContent[] {
  return [
    { kind: 'markdown', body: '# Roadmap\n\nShip search.' },
    { kind: 'markdown', body: '# Roadmap', description: 'Quarterly summary' },
    { kind: 'markdown', body: '# Roadmap', description: '' },
    { kind: 'markdown', body: '', description: '検索' },
    { kind: 'markdown', body: '' },
    {
      kind: 'spatial',
      canvas: canvas(
        [
          textNode({ id: 'n1', text: 'Auth flow', ...box }),
          groupNode({ id: 'g1', label: 'Backlog', x: 0, y: 0, width: 200, height: 200 }),
        ],
        [{ id: 'e1', from: { node: 'n1' }, to: { node: 'g1' }, label: 'blocks' }],
      ),
    },
    {
      kind: 'spatial',
      canvas: canvas([
        linkNode({ id: 'l1', url: 'https://example.com/runbooks/oncall', ...box }),
        textNode({ id: 't1', text: '日本語のメモ', ...box }),
        textNode({ id: 't2', text: '', ...box }),
      ]),
    },
    {
      kind: 'spatial',
      canvas: canvas([fileNode({ id: 'f1', file: '01JBQ7Z2K3M4N5P6Q7R8S9T0V1', ...box })]),
    },
    {
      kind: 'spatial',
      canvas: canvas(
        [groupNode({ id: 'g1', x: 0, y: 0, width: 10, height: 10 })],
        [{ id: 'e1', from: { node: 'g1' }, to: { node: 'g1' } }],
      ),
    },
    { kind: 'spatial', canvas: canvas([]) },
    {
      kind: 'spatial',
      canvas: canvas(
        [
          textNode({ id: 'a', text: 'Café', ...box }),
          textNode({ id: 'b', text: '🚀 launch', ...box }),
          groupNode({ id: 'g', label: '', x: 0, y: 0, width: 5, height: 5 }),
        ],
        [
          { id: 'e1', from: { node: 'a' }, to: { node: 'b' }, label: '' },
          { id: 'e2', from: { node: 'b' }, to: { node: 'a' }, label: 'ならば' },
        ],
      ),
    },
  ]
}
