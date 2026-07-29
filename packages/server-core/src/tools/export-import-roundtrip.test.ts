import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { readFacets, readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
} from '../test-utils/fake-canvas-doc-store.js'
import { createCanvasExportJsonCanvasTool } from './canvas-export-json-canvas.js'
import { createCanvasExportOkfTool } from './canvas-export-okf.js'
import { createCanvasImportOkfTool, OkfParseError } from './canvas-import-okf.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, workspaceIndex: {} as never, blobStore: {} as never }
}

async function loadDoc(store: FakeCanvasDocStore, canvasId: string): Promise<LoroDoc> {
  const snap = await store.loadSnapshot({ docRef: { kind: 'canvas', canvasId } })
  if (!snap) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
  return doc
}

describe('canvas_import_okf -> canvas_export_okf composed round-trip', () => {
  test('preserves body text through the LoroDoc persistence layer', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportTool = createCanvasExportOkfTool(makeDeps(store))

    const markdown = '---\ntype: note\n---\n# Title\n\nBody text.'
    await importTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    const result = await exportTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.markdown).toContain('# Title\n\nBody text.')
  })

  test('preserves facets with arbitrary domain keys through the LoroDoc persistence layer', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportTool = createCanvasExportOkfTool(makeDeps(store))

    const markdown = [
      '---',
      'type: issue',
      'facets:',
      '  issue/1:',
      '    status: open',
      '    priority: high',
      '---',
      'Body.',
    ].join('\n')
    await importTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    const result = await exportTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.frontmatter.facets).toEqual({ 'issue/1': { status: 'open', priority: 'high' } })
  })

  test('an empty (facets-only) body round-trips to an empty body', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportTool = createCanvasExportOkfTool(makeDeps(store))

    await importTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\n',
    })

    const result = await exportTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.markdown.endsWith('---\n')).toBe(true)
  })

  test('re-import after export is idempotent: the second import produces the same LoroDoc state', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportTool = createCanvasExportOkfTool(makeDeps(store))

    const markdown = '---\ntype: note\nfacets:\n  kanban/1:\n    status: todo\n---\nOriginal body.'
    await importTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })
    const exported = await exportTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    await importTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: exported.markdown,
    })
    const doc = await loadDoc(store, CANVAS_ID)

    expect(readFacets(doc)).toEqual({ 'kanban/1': { status: 'todo' } })
    const canvas = readSpatialCanvas(doc)
    expect(canvas.nodes).toHaveLength(1)
    if (canvas.nodes[0].type === 'text') {
      expect(canvas.nodes[0].text).toBe('Original body.')
    }
  })
})

describe('canvas_import_okf -> canvas_export_json_canvas composed round-trip', () => {
  test('the imported body appears as a text node in the exported (extended) JSON Canvas', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportJsonTool = createCanvasExportJsonCanvasTool(makeDeps(store))

    await importTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nHello from OKF.',
    })

    const result = await exportJsonTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0].text).toBe('Hello from OKF.')
  })

  test('the exported (strict) JSON Canvas has no x-whiteboard extensions', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportJsonTool = createCanvasExportJsonCanvasTool(makeDeps(store))

    await importTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nHello.',
    })

    const result = await exportJsonTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      options: { strict: true },
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toBeUndefined()
  })
})

describe('canvas_export_json_canvas output re-parses as valid JSON Canvas', () => {
  test('parseSpatial succeeds on the exported (extended) JSON', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportJsonTool = createCanvasExportJsonCanvasTool(makeDeps(store))

    await importTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nRe-parse me.',
    })
    const result = await exportJsonTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    const reparsed = parseSpatial(result.json)

    expect(reparsed.ok).toBe(true)
  })

  test('parseSpatial succeeds on the exported (strict) JSON', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportJsonTool = createCanvasExportJsonCanvasTool(makeDeps(store))

    await importTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      markdown: '---\ntype: note\n---\nRe-parse me too.',
    })
    const result = await exportJsonTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      options: { strict: true },
    })

    const reparsed = parseSpatial(result.json)

    expect(reparsed.ok).toBe(true)
  })
})

describe('error paths do not silently produce corrupt output', () => {
  test('import_okf with no frontmatter rejects before any export is attempted', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportTool = createCanvasExportOkfTool(makeDeps(store))

    await expect(
      importTool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        markdown: 'no frontmatter here',
      }),
    ).rejects.toThrow(OkfParseError)

    // No snapshot was ever saved, so the composed export attempt surfaces a
    // clean not-found error rather than reading corrupt/partial state.
    await expect(
      exportTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  test('a non-yaml-safe facet value (YAML .nan) imports but rejects on export, never silently exported', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const importTool = createCanvasImportOkfTool(makeDeps(store))
    const exportTool = createCanvasExportOkfTool(makeDeps(store))

    // parseOkf's frontmatter schema only validates facet KEYS, not values
    // (extensionFacetsSchema stores values as z.unknown()) — the yaml-safe
    // check runs on serialize, so a YAML-native `.nan` scalar (parsed to the
    // JS NaN, which has no round-trippable YAML representation) imports
    // successfully but must fail the composed export rather than silently
    // emitting corrupt YAML.
    const markdown = '---\ntype: note\nfacets:\n  bad/1:\n    value: .nan\n---\nBody.'
    await importTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    await expect(
      exportTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(/yaml-safe/)
  })

  test('export_okf on a canvas with no stored snapshot surfaces a clean error', async () => {
    const store = new FakeCanvasDocStore()
    const exportTool = createCanvasExportOkfTool(makeDeps(store))

    await expect(
      exportTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  test('export_json_canvas on a canvas with no stored snapshot surfaces a clean error', async () => {
    const store = new FakeCanvasDocStore()
    const exportJsonTool = createCanvasExportJsonCanvasTool(makeDeps(store))

    await expect(
      exportJsonTool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
