/**
 * A record whose document node holds a scalar, or a container of another
 * kind, at a content key — written before the sync judge refused one, so it
 * may be on disk. Opening a container over either throws a bare string out
 * of the engine or hands back the wrong container, so nothing here opens one
 * there: what has to hand a container back fails with a typed error, and a
 * whole-document write or copy leaves the key alone or drops it.
 */
import { LoroDoc, LoroMap, LoroText, type LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { scanFileReferences } from './file-references.js'
import { collectImageRefIds } from './image-refs.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  importWorkspaceSubtree,
  readWorkspaceDocuments,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

function nodeData(doc: LoroDoc, documentId = DOC_ID): LoroTreeNode['data'] {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === documentId)
  if (node === undefined) throw new Error(`no node holds ${documentId}`)
  return node.data
}

const HELD: ReadonlyArray<readonly [string, string, (data: LoroTreeNode['data']) => void]> = [
  ['a scalar', 'nodes', (data) => data.set('nodes', 1)],
  ['a text where a map belongs', 'nodes', (data) => data.setContainer('nodes', new LoroText())],
  ['a map where a text belongs', 'body', (data) => data.setContainer('body', new LoroMap())],
]

function stored(hold: (data: LoroTreeNode['data']) => void): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  hold(nodeData(doc))
  doc.commit()
  return doc
}

/** What a throw is, so a bare engine string reads as one rather than passing `rejects`. */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (err) {
    return err
  }
  return 'no throw'
}

describe.each(HELD)('a document node holding %s at %s', (_what, key, hold) => {
  it("opening the document's containers fails with a typed error", () => {
    const doc = stored(hold)

    const err = thrown(() => collectImageRefIds(documentContainers(doc, DOC_ID)))

    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ name: 'UnreadableDocumentContentError', key })
  })

  it('a whole-content write leaves the key alone and writes the rest', () => {
    const doc = stored(hold)
    const source = new LoroDoc()
    source.getMap('canvas').set('tags', ['kept'])
    source.commit()

    expect(writeWorkspaceDocumentContent(doc, DOC_ID, source)).toBe(true)

    expect((nodeData(doc).get('canvas') as LoroMap).get('tags')).toEqual(['kept'])
  })

  it('deleting it to the trash and restoring it gives a readable document', () => {
    const doc = stored(hold)
    const bytes = exportWorkspaceSubtree(doc, 'notes')
    if (bytes === null) throw new Error('nothing exported')

    const restored = new LoroDoc()
    importWorkspaceSubtree(restored, bytes)

    expect(readWorkspaceDocuments(restored).map((entry) => entry.documentId)).toEqual([DOC_ID])
    expect(collectImageRefIds(documentContainers(restored, DOC_ID))).toEqual(new Set())
  })

  it('a file collection reports it rather than failing untyped', async () => {
    const doc = stored(hold)

    const err = await scanFileReferences(doc, { trashBytes: async () => null }).catch(
      (cause: unknown) => cause,
    )

    expect(err).toMatchObject({ name: 'UnreadableDocumentContentError', key })
  })
})
