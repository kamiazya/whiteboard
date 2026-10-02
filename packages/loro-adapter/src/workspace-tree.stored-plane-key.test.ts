/**
 * A node's data map once carried a `plane:`-prefixed child map beside a
 * document's content: the record's branch state. The branch is gone
 * (ADR-0029) and nothing writes one now, but a record written while branches
 * existed still holds it, and a content reader that took it for content would
 * project it into the document every exporter, renderer and digest sees —
 * then write the stale copy back on the next save.
 */
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceDocument,
  projectWorkspaceDocument,
  WORKSPACE_TREE_KEY,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const DOCUMENT_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const STORED_KEY = 'plane:branches'

/** A record as the branch-era writer left it: the plane on the node, beside the content. */
function recordWithStoredPlane(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocument(doc, { documentId: DOCUMENT_ID, segment: 'untitled', kind: 'spatial' })
  const node = doc
    .getTree(WORKSPACE_TREE_KEY)
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === DOCUMENT_ID)
  if (node === undefined) throw new Error('the document node is missing')
  node.data.setContainer(STORED_KEY, new LoroMap()).set('draft', { tip: 'AQID' })
  doc.commit()
  return doc
}

function storedPlane(doc: LoroDoc): unknown {
  const node = doc
    .getTree(WORKSPACE_TREE_KEY)
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === DOCUMENT_ID)
  return (node?.data.get(STORED_KEY) as LoroMap | undefined)?.toJSON()
}

describe('a plane key stored on a document node', () => {
  it('stays out of the document’s projection', () => {
    const doc = recordWithStoredPlane()
    expect(storedPlane(doc)).toEqual({ draft: { tip: 'AQID' } })

    const projected = projectWorkspaceDocument(doc, DOCUMENT_ID)

    expect(
      Object.keys(projected?.toJSON() ?? {}).filter((key) => key.endsWith('branches')),
    ).toEqual([])
  })

  it('is not rewritten by a content save from a source that carries it', () => {
    const doc = recordWithStoredPlane()
    const source = new LoroDoc()
    source.getMap(STORED_KEY).set('draft', { tip: '' })
    source.getMap('nodes').set('a', 1)
    source.commit()

    writeWorkspaceDocumentContent(doc, DOCUMENT_ID, source)

    expect(storedPlane(doc)).toEqual({ draft: { tip: 'AQID' } })
  })
})
