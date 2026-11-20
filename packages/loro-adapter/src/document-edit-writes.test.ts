import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readDocumentContent } from './document-content.js'
import { applyDocumentEdit, type DocumentEdit, documentEditWrites } from './document-edit.js'
import { createCrdtEngine } from './engine/engine.js'
import { ownedLease, read, write } from './engine/lease.js'
import { writeSpatialCanvas } from './loro-bridge.js'
import { writeMarkdownBody } from './markdown-body.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

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

const open = (doc: LoroDoc) => {
  const engine = createCrdtEngine()
  const bytes = bytesToBase64(doc.export({ mode: 'snapshot' }))
  return ownedLease(engine, engine.open({ peer: '1', bytes }).handle)
}

const asIs = { parse: (value: unknown) => value }

describe('documentEditWrites', () => {
  it.each(EDITS)('leaves a record as applyDocumentEdit does: %s', async (_name, id, edit) => {
    const direct = recordDoc()
    applyDocumentEdit(documentContainers(direct, id), edit)
    const record = open(recordDoc())
    try {
      write(record, documentEditWrites(edit, id), { judge: 'none' })
      const through = await read(
        record,
        { query: 'documentContent', args: { documentId: id } },
        asIs,
      )
      expect(through).toEqual(readDocumentContent(documentContainers(direct, id)))
    } finally {
      record.release()
    }
  })

  it.each(
    EDITS.filter(([, id]) => id === MD).map(([name, , edit]) => [name, edit] as const),
  )('leaves a document that is its own record as applyDocumentEdit does: %s', async (_name, edit) => {
    const seed = new LoroDoc()
    writeMarkdownBody(seed, 'Beta and Beta again')
    seed.commit()
    const direct = LoroDoc.fromSnapshot(seed.export({ mode: 'snapshot' }))
    applyDocumentEdit(direct, edit)
    const held = open(seed)
    try {
      write(held, documentEditWrites(edit), { judge: 'none' })
      expect(await read(held, { query: 'documentContent' }, asIs)).toEqual(
        readDocumentContent(direct),
      )
    } finally {
      held.release()
    }
  })
})
