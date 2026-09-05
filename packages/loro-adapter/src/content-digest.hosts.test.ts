/**
 * One document, one identity — wherever its containers are hosted.
 *
 * The same content can be held three ways in this codebase: as a node of the
 * workspace tree (what a list row reads), as a projected standalone document
 * (what the daemon serves and a duplicate seeds from), and as a fresh
 * standalone document (what an editor session or a browser-kept markdown
 * document holds). A picture of it is memoised under its identity, so the
 * three hosts have to agree on that identity or the same content is drawn
 * once per host and shared by none of them.
 *
 * Measured before this was written: the tree and the projection agreed and
 * the fresh document did not — the tree pre-attaches every content container
 * (so empty maps and an empty text are present), a fresh document only has
 * the containers something wrote. Same content, different JSON, different
 * digest. Normalising "absent" and "empty" to one thing is what makes the
 * three agree, and the property below holds it over random canvases.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { contentDigestOfDocument } from './content-digest.js'
import { MARKDOWN_BODY_KEY, writeSpatialCanvas } from './loro-bridge.js'
import { fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  createWorkspaceDocumentAtPath,
  projectWorkspaceDocument,
  readWorkspaceDocuments,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const ID = '01JQXYZ0000000000000000000'

function freshSpatial(canvas: SpatialCanvas): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc
}

function freshMarkdown(body: string): LoroDoc {
  const doc = new LoroDoc()
  doc.getText(MARKDOWN_BODY_KEY).insert(0, body)
  doc.commit()
  return doc
}

function treeHolding(source: LoroDoc, kind: 'spatial' | 'markdown'): LoroDoc {
  const ws = new LoroDoc()
  createWorkspaceDocumentAtPath(ws, { path: 'a', documentId: ID, kind })
  writeWorkspaceDocumentContent(ws, ID, source)
  return ws
}

function treeDigest(ws: LoroDoc): string {
  const found = readWorkspaceDocuments(ws).find((e) => e.documentId === ID)
  if (found === undefined) throw new Error('document not listed')
  return found.contentDigest
}

describe('one identity across hosts', () => {
  it('a spatial document digests the same as a tree node, a projection and a fresh document', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n0', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    }
    const fresh = freshSpatial(canvas)
    const ws = treeHolding(fresh, 'spatial')
    const projected = projectWorkspaceDocument(ws, ID)
    if (projected === null) throw new Error('no projection')

    const fromTree = treeDigest(ws)
    expect(contentDigestOfDocument(projected)).toBe(fromTree)
    expect(contentDigestOfDocument(fresh)).toBe(fromTree)
  })

  // The browser-kept markdown document is the fresh-host case that matters
  // most: it never reaches the sync session, so its icon's key can only come
  // from this, and the list row's key for the same document comes from the
  // tree.
  it('a markdown document digests the same from its own document as from the tree', () => {
    const fresh = freshMarkdown('# Heading\n\nA paragraph.\n')
    const ws = treeHolding(fresh, 'markdown')
    expect(contentDigestOfDocument(fresh)).toBe(treeDigest(ws))
  })

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'tree node, projection and fresh document agree on any canvas',
    (canvas) => {
      const fresh = freshSpatial(canvas)
      const ws = treeHolding(fresh, 'spatial')
      const projected = projectWorkspaceDocument(ws, ID)
      if (projected === null) throw new Error('no projection')
      const fromTree = treeDigest(ws)
      expect(contentDigestOfDocument(projected)).toBe(fromTree)
      expect(contentDigestOfDocument(fresh)).toBe(fromTree)
    },
  )

  // The digest reads the live document, not its commit log: an edit that is
  // written but not yet committed is already part of the state it names, and
  // committing it changes nothing. (Whether an OWNER writes at once or on a
  // debounce is that owner's business — the sync session defers its write,
  // the markdown binding does not — and either way the key describes the
  // document as it stands.)
  it('moves on an edit before it is committed, and not again when it is', () => {
    const doc = freshSpatial({ nodes: [], edges: [] })
    const before = contentDigestOfDocument(doc)

    doc.getMap('nodes').set('n1', { id: 'n1', type: 'text', x: 1, y: 1, width: 1, height: 1 })
    const pending = contentDigestOfDocument(doc)
    expect(pending).not.toBe(before)

    doc.commit()
    expect(contentDigestOfDocument(doc)).toBe(pending)
  })

  it('is blind to containers that hold nothing, whichever host attached them', () => {
    const doc = new LoroDoc()
    const empty = contentDigestOfDocument(doc)
    // Touching a root container attaches it, empty. Content did not change.
    doc.getMap('nodes')
    doc.getText(MARKDOWN_BODY_KEY)
    expect(contentDigestOfDocument(doc)).toBe(empty)
  })
})
