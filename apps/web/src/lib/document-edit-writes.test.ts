import {
  applyDocumentEdit,
  createWorkspaceDocumentAtPath,
  type DocumentEdit,
  documentContainers,
  lease,
  readDocumentContent,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { leaseOf } from '../test-utils/replica-lease.js'
import { documentEditWrites } from './document-edit-writes.js'

const MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const SP = '01ARZ3NDEKTSV4RRFFQ69G5FB2'

function recordDoc(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: MD, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, MD), 'Beta and Beta again')
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: SP, kind: 'spatial' })
  const a = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'one' })
  writeSpatialCanvas(documentContainers(doc, SP), { nodes: [a], edges: [] })
  doc.commit()
  return doc
}

const b = textNode({ id: 'b', x: 10, y: 10, width: 100, height: 50, text: 'two' })
const a2 = textNode({ id: 'a', x: 5, y: 5, width: 100, height: 50, text: 'changed' })

const EDITS: ReadonlyArray<readonly [string, string, DocumentEdit]> = [
  [
    'markdown splices, in descending order',
    MD,
    {
      kind: 'markdown-splices',
      runs: [
        { index: 9, remove: 4, insert: '[[beta|Beta]]' },
        { index: 0, remove: 4, insert: '[[beta|Beta]]' },
      ],
    },
  ],
  ['a whole markdown body', MD, { kind: 'markdown-body', body: '# New\n\nbody' }],
  ['spatial nodes', SP, { kind: 'spatial-nodes', nodes: [a2, b] }],
  [
    'a spatial canvas diff',
    SP,
    {
      kind: 'spatial-canvas',
      before: {
        nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'one' })],
        edges: [],
      },
      after: { nodes: [b], edges: [] },
    },
  ],
]

describe('documentEditWrites', () => {
  it.each(EDITS)('leaves the document as applyDocumentEdit does: %s', async (_name, id, edit) => {
    const direct = recordDoc()
    applyDocumentEdit(documentContainers(direct, id), edit)
    const record = await leaseOf(recordDoc())
    try {
      lease.write(record, documentEditWrites(id, edit), { judge: 'none' })
      const through = await lease.read(
        record,
        { query: 'documentContent', args: { documentId: id } },
        { parse: (value) => value },
      )
      expect(through).toEqual(readDocumentContent(documentContainers(direct, id)))
    } finally {
      record.release()
    }
  })
})
