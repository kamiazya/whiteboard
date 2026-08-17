import {
  readDocumentKind,
  readFacets,
  readMarkdownBody,
  readSpatialCanvas,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { createDocumentSetTool } from './document-set.js'
import { DocumentContentLossError, DocumentKindMismatchError } from './errors.js'
import { exportOkf } from './export-okf.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
}

async function loadDoc(store: FakeDocumentStore, documentId: string): Promise<LoroDoc> {
  const snap = await store.loadSnapshot({ docRef: { kind: 'document', documentId } })
  if (!snap) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
  return doc
}

describe('wb_document_set tool', () => {
  test('imports markdown with facets and body into a new LoroDoc', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createDocumentSetTool(makeDeps(store))

    const markdown = [
      '---',
      'type: issue',
      'facets:',
      '  example/1:',
      '    status: open',
      '    priority: high',
      '---',
      '# Bug report',
      '',
      'Something is broken.',
    ].join('\n')

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown,
    })

    expect(result.documentId).toBe(CANVAS_ID)
    expect(result.imported).toBe(true)

    const doc = await loadDoc(store, CANVAS_ID)
    const facets = readFacets(doc)
    expect(facets).toEqual({ 'example/1': { status: 'open', priority: 'high' } })

    expect(readMarkdownBody(doc)).toBe('# Bug report\n\nSomething is broken.')
    // And the document is NOT also a spatial canvas. The body used to be
    // stored as a text node, which is what made every markdown document
    // parse as a valid one-node canvas.
    expect(readSpatialCanvas(doc).nodes).toEqual([])
  })

  test('imports markdown with empty body (facets only)', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createDocumentSetTool(makeDeps(store))

    const markdown = '---\ntype: note\n---\n'

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown,
    })

    expect(result.imported).toBe(true)

    const doc = await loadDoc(store, CANVAS_ID)
    const canvas = readSpatialCanvas(doc)
    expect(canvas.nodes).toHaveLength(0)
  })

  test('overwrites existing doc on re-import', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createDocumentSetTool(makeDeps(store))

    const v1 = '---\ntype: issue\nfacets:\n  example/1:\n    status: open\n---\nFirst body.'
    await tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID, markdown: v1 })

    const v2 = '---\ntype: issue\nfacets:\n  example/1:\n    status: closed\n---\nUpdated body.'
    await tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID, markdown: v2 })

    const doc = await loadDoc(store, CANVAS_ID)
    const facets = readFacets(doc)
    expect(facets['example/1']).toEqual({ status: 'closed' })

    // Overwritten, not appended: the second import replaces the body rather
    // than leaving the first one alongside it.
    expect(readMarkdownBody(doc)).toBe('Updated body.')
    expect(readSpatialCanvas(doc).nodes).toEqual([])
  })

  test('rejects invalid OKF markdown', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createDocumentSetTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: CANVAS_ID,
        markdown: 'no frontmatter',
      }),
    ).rejects.toThrow()
  })

  test('rejects when canvas is not in workspace', async () => {
    const store = new FakeDocumentStore()
    const tool = createDocumentSetTool(makeDeps(store))

    const markdown = '---\ntype: note\n---\nBody.'

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: CANVAS_ID, markdown }),
    ).rejects.toThrow()
  })

  test('refuses a spatial document instead of flattening it into one text node', async () => {
    // This write replaces the whole spatial canvas. Run unguarded against a
    // diagram and the nodes and edges are gone, which is not a rejected write
    // but a silently destroyed document (ADR-0009 decision 4).
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'diagram' }],
        edges: [],
      })
    })
    const tool = createDocumentSetTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: CANVAS_ID,
        markdown: '---\ntype: note\n---\nBody.',
      }),
    ).rejects.toThrow(DocumentKindMismatchError)

    const canvas = readSpatialCanvas(await loadDoc(store, CANVAS_ID))
    expect(canvas.nodes).toHaveLength(1)
    expect(canvas.nodes[0].id).toBe('n1')
  })

  test('writes a markdown document, and leaves it recorded as markdown', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => writeDocumentKind(doc, 'markdown'))
    const tool = createDocumentSetTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nBody.',
    })

    expect(readDocumentKind(await loadDoc(store, CANVAS_ID))).toBe('markdown')
  })

  test('a document predating kinds is healed by the write, not refused', async () => {
    // The only way an existing document gets a kind. Refusing here would
    // leave every pre-kind document unreadable through wb_document_get and
    // unwritable through this tool, with no path out.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createDocumentSetTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nBody.',
    })

    expect(readDocumentKind(await loadDoc(store, CANVAS_ID))).toBe('markdown')
  })

  test('a document predating kinds that holds only an OKF body is still healed', async () => {
    // A markdown document's stored content is a valid spatial canvas: its
    // body lives in one text node. So "holds nodes" alone would refuse the
    // pre-kind markdown documents the OKF import path produced, and send
    // them to wb_node_add, which would declare them spatial — the wrong
    // kind, and the "no way back" the healing exists to prevent.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          { id: 'okf-body', type: 'text', x: 0, y: 0, width: 600, height: 400, text: 'Old body.' },
        ],
        edges: [],
      })
    })
    const tool = createDocumentSetTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nNew body.',
    })

    const doc = await loadDoc(store, CANVAS_ID)
    expect(readDocumentKind(doc)).toBe('markdown')
    expect(readMarkdownBody(doc)).toBe('New body.')
    // The legacy okf-body node it was healed FROM is gone, so a later read
    // cannot find a stale second body behind the fresh one.
    expect(readSpatialCanvas(doc).nodes).toEqual([])
  })

  test('a document predating kinds that holds nodes is refused, not flattened', async () => {
    // The healing above is safe because an empty document has nothing to
    // lose. A pre-kind document that holds a diagram does: this write
    // replaces a spatial canvas outright, and the mismatch guard that
    // normally refuses that is skipped for exactly this document, because
    // its kind is absent rather than wrong.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'diagram' }],
        edges: [],
      })
    })
    const tool = createDocumentSetTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: CANVAS_ID,
        markdown: '---\ntype: note\n---\nBody.',
      }),
    ).rejects.toThrow(DocumentContentLossError)

    const doc = await loadDoc(store, CANVAS_ID)
    expect(readSpatialCanvas(doc).nodes).toHaveLength(1)
    // Refused, so still undeclared — the spatial path is what declares it.
    expect(readDocumentKind(doc)).toBeUndefined()
  })
})

describe('OKF title is a projection of the workspace name, both ways', () => {
  // OKF is an export format, not the storage model: the Loro side keeps its
  // own OKF-compatible document, and the workspace owns the name. So parsing
  // an OKF is projecting it INTO that model, exactly as serialising projects
  // back out — `title` lands on the workspace, never in the content.
  test('a title in the written OKF renames the document, and is not stored as a facet', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const deps = makeDeps(store)

    await createDocumentSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\ntitle: リリース計画 2026\n---\nBody.',
    })

    const entry = await store.documentIndex.resolveDocumentById({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
    })
    expect(entry?.name).toBe('リリース計画 2026')
    // Asserted against the raw `core` map rather than `readCoreFacets`: the
    // stored shape no longer HAS a title field, so a read can only ever
    // answer undefined. What is worth pinning is that the write did not put
    // one in the document behind that read.
    expect((await loadDoc(store, CANVAS_ID)).getMap('core').get('title')).toBeUndefined()
  })

  test('writing OKF without a title leaves the existing name alone', async () => {
    // Absent is not the same as cleared. An OKF with no `title` says nothing
    // about the name, so a write that omits it must not erase one.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const deps = makeDeps(store)
    await createDocumentSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\ntitle: Keep me\n---\nOne.',
    })

    await createDocumentSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nTwo.',
    })

    const entry = await store.documentIndex.resolveDocumentById({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
    })
    expect(entry?.name).toBe('Keep me')
  })

  test('the exported OKF carries the workspace name as its title', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const deps = makeDeps(store)
    await createDocumentSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\ntitle: Round trip\n---\nBody.',
    })

    const exported = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })

    expect(exported.frontmatter.title).toBe('Round trip')
    expect(exported.markdown).toContain('title: Round trip')
  })

  test('a blank title round-trips to no title, not to an empty one', async () => {
    // The shrunk counterexample from the round-trip property, pinned as the
    // regression guard: {"frontmatter":{"type":" ","title":""},"body":""}.
    // A blank name IS no name — the two are deliberately one state — so the
    // round trip normalises here rather than preserving '' verbatim.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const deps = makeDeps(store)
    await createDocumentSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\ntitle: ""\n---\n',
    })

    const exported = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })

    expect(exported.frontmatter.title).toBeUndefined()
  })

  test('an unnamed document exports no title at all, rather than its path', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const deps = makeDeps(store)
    await createDocumentSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nBody.',
    })

    const exported = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: CANVAS_ID })

    expect(exported.frontmatter.title).toBeUndefined()
  })
})
