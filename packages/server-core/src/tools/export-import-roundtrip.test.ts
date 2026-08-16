import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import {
  readFacets,
  readMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
  seedDoc,
} from '../test-utils/fake-canvas-doc-store.js'
import { createDocumentSetTool, OkfParseError } from './document-set.js'
import { exportJsonCanvas } from './export-json-canvas.js'
import { exportOkf } from './export-okf.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never, documentIndex: canvasDocStore.documentIndex }
}

async function loadDoc(store: FakeCanvasDocStore, canvasId: string): Promise<LoroDoc> {
  const snap = await store.loadSnapshot({ docRef: { kind: 'canvas', canvasId } })
  if (!snap) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
  return doc
}

async function setupTools() {
  const store = new FakeCanvasDocStore()
  await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
  const deps = makeDeps(store)
  return {
    store,
    deps,
    documentSet: createDocumentSetTool(deps),
  }
}

describe('wb_document_set -> OKF export composed round-trip', () => {
  test('preserves body text through the LoroDoc persistence layer', async () => {
    const { documentSet, deps } = await setupTools()

    const markdown = '---\ntype: note\n---\n# Title\n\nBody text.'
    await documentSet.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.markdown).toContain('# Title\n\nBody text.')
  })

  test('preserves core facets (type/title/tags/view) through the LoroDoc persistence layer', async () => {
    const { documentSet, deps } = await setupTools()

    const markdown = [
      '---',
      'type: note',
      'title: "Future: browser-extension auto-connect to the local daemon"',
      'tags:',
      '  - idea',
      '  - browser',
      'view: kanban/1',
      'facets:',
      '  note/1:',
      '    status: idea',
      '---',
      'Body text.',
    ].join('\n')
    await documentSet.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.frontmatter.type).toBe('note')
    expect(result.frontmatter.title).toBe(
      'Future: browser-extension auto-connect to the local daemon',
    )
    expect(result.frontmatter.tags).toEqual(['idea', 'browser'])
    expect(result.frontmatter.view).toBe('kanban/1')
    expect(result.frontmatter.facets).toEqual({ 'note/1': { status: 'idea' } })
  })

  test('preserves facets with arbitrary domain keys through the LoroDoc persistence layer', async () => {
    const { documentSet, deps } = await setupTools()

    const markdown = [
      '---',
      'type: issue',
      'facets:',
      '  example/1:',
      '    status: open',
      '    priority: high',
      '---',
      'Body.',
    ].join('\n')
    await documentSet.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.frontmatter.facets).toEqual({ 'example/1': { status: 'open', priority: 'high' } })
  })

  test('an empty (facets-only) body round-trips to an empty body', async () => {
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\n',
    })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.markdown.endsWith('---\n')).toBe(true)
  })

  test('re-import after export is idempotent: the second import produces the same LoroDoc state', async () => {
    const { store, documentSet, deps } = await setupTools()

    const markdown = '---\ntype: note\nfacets:\n  kanban/1:\n    status: todo\n---\nOriginal body.'
    await documentSet.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })
    const exported = await exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: exported.markdown,
    })
    const doc = await loadDoc(store, CANVAS_ID)

    expect(readFacets(doc)).toEqual({ 'kanban/1': { status: 'todo' } })
    expect(readMarkdownBody(doc)).toBe('Original body.')
  })
})

describe('wb_document_set -> the JSON Canvas exporter composed round-trip', () => {
  test('a markdown document has no canvas to export as JSON Canvas', async () => {
    // It used to have exactly one node, because the body was STORED as a
    // text node. That is what made a markdown document also parse as a
    // valid canvas, and why anything resolving a reference had to ask the
    // document its kind before it could tell prose from a diagram. The body
    // now lives in its own container, so the canvas is genuinely empty.
    //
    // Unreachable in production either way: `wb_document_get` routes by
    // kind, so a markdown document is exported as OKF and only a spatial
    // one ever reaches this exporter. Asserted here because the old
    // assertion encoded the ambiguity, not because the path is used.
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nHello from OKF.',
    })

    const result = await exportJsonCanvas(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    expect(JSON.parse(result.json).nodes).toEqual([])

    // The body is not lost — it is read through its own accessor, which is
    // what the OKF export uses.
    const okf = await exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    expect(okf.markdown).toContain('Hello from OKF.')
  })

  test('the exported (strict) JSON Canvas has no x-whiteboard extensions', async () => {
    // Seeded as a SPATIAL document carrying the extension, which is both
    // what this exporter is actually for and the only way this assertion
    // can fail. It used to seed markdown and index `nodes[0]`, which worked
    // only because a markdown body was stored as a node; over an empty
    // node list the same loop would pass while checking nothing.
    const { store, deps } = await setupTools()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          {
            id: 'n1',
            type: 'text',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            text: 'hi',
            'x-whiteboard': { kind: 'embed', canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
          },
        ],
        edges: [],
      })
    })

    const result = await exportJsonCanvas(deps, {
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      options: { strict: true },
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0]['x-whiteboard']).toBeUndefined()
  })
})

describe('the JSON Canvas exporter output re-parses as valid JSON Canvas', () => {
  test('parseSpatial succeeds on the exported (extended) JSON', async () => {
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nRe-parse me.',
    })
    const result = await exportJsonCanvas(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(parseSpatial(result.json).ok).toBe(true)
  })

  test('parseSpatial succeeds on the exported (strict) JSON', async () => {
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nRe-parse me too.',
    })
    const result = await exportJsonCanvas(deps, {
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      options: { strict: true },
    })

    expect(parseSpatial(result.json).ok).toBe(true)
  })
})

describe('error paths do not silently produce corrupt output', () => {
  test('import_okf with no frontmatter rejects before any export is attempted', async () => {
    const { documentSet, deps } = await setupTools()

    await expect(
      documentSet.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        markdown: 'no frontmatter here',
      }),
    ).rejects.toThrow(OkfParseError)

    // No snapshot was ever saved, so the composed export attempt surfaces a
    // clean not-found error rather than reading corrupt/partial state.
    await expect(
      exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  test('a non-yaml-safe facet value (YAML .nan) imports but rejects on export, never silently exported', async () => {
    const { documentSet, deps } = await setupTools()

    // parseOkf's frontmatter schema only validates facet KEYS, not values
    // (extensionFacetsSchema stores values as z.unknown()) — the yaml-safe
    // check runs on serialize, so a YAML-native `.nan` scalar (parsed to the
    // JS NaN, which has no round-trippable YAML representation) imports
    // successfully but must fail the composed export rather than silently
    // emitting corrupt YAML.
    const markdown = '---\ntype: note\nfacets:\n  bad/1:\n    value: .nan\n---\nBody.'
    await documentSet.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    await expect(
      exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(/yaml-safe/)
  })

  test('export_okf on a canvas with no stored snapshot surfaces a clean error', async () => {
    const deps = makeDeps(new FakeCanvasDocStore())

    await expect(
      exportOkf(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  test('export_json_canvas on a canvas with no stored snapshot surfaces a clean error', async () => {
    const deps = makeDeps(new FakeCanvasDocStore())

    await expect(
      exportJsonCanvas(deps, { workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
