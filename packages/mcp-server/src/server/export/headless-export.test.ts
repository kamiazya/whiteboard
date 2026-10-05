import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { testStoreScope } from '../routes/_test-helpers.js'
import type { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } from './headless-renderer.js'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const renderSpy = vi.fn<typeof renderSpatialCanvasToPng>(async () => ({
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  width: 10,
  height: 10,
  undrawable: [],
  unresolvedFamilies: [],
}))
const renderSvgSpy = vi.fn<typeof renderSpatialCanvasToSvg>(async () => ({
  svg: '<svg><rect/></svg>',
  undrawable: [],
  unresolvedFamilies: [],
}))
vi.mock('./headless-renderer.js', () => ({
  renderSpatialCanvasToPng: renderSpy,
  renderSpatialCanvasToSvg: renderSvgSpy,
}))

const { exportCanvasHeadless, exportCanvasHeadlessSvg } = await import('./headless-export.js')
const { saveDocument, documentExists } = await import('../store/document-store.js')
const { clearDocCacheForTests } = await import('../store/doc-cache.js')

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-headless-export-test-'))
  clearDocCacheForTests()
  renderSpy.mockClear()
  renderSvgSpy.mockClear()
})

afterEach(async () => {
  clearDocCacheForTests()
  await rm(tempDir, { recursive: true, force: true })
})

function spatialTextDoc(nodeId: string, text: string): LoroDoc {
  const doc = new LoroDoc()
  const nodes = doc.getMap('nodes')
  nodes.set(nodeId, textNode({ id: nodeId, x: 0, y: 0, width: 100, height: 50, text }))
  doc.commit()
  return doc
}

describe('exportCanvasHeadless', () => {
  it('reads the doc, derives the spatial canvas, and forwards padding/scale/theme to the renderer', async () => {
    const doc = spatialTextDoc('n1', 'hello')
    await saveDocument('ws_a', 'design', doc)

    await exportCanvasHeadless({
      scope: testStoreScope(),
      workspaceId: 'ws_a',
      path: 'design',
      options: { padding: 20, scale: 2, theme: 'dark' },
    })

    expect(renderSpy).toHaveBeenCalledTimes(1)
    const [canvas, fontsDir, options] = renderSpy.mock.calls[0]!
    expect(canvas.nodes.map((n) => n.id)).toEqual(['n1'])
    // The renderer is keyed by the fonts directory of the scope being served.
    expect(fontsDir).toBe(testStoreScope().layout.fontsDir)
    expect(options).toEqual({ padding: 20, scale: 2, theme: 'dark' })
  })

  it('exports an empty canvas, without a warning, for a doc holding only the retired elements list', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const rect = list.insertContainer(0, new LoroMap())
    rect.set('id', 'legacy-1')
    rect.set('type', 'rectangle')
    rect.set('isDeleted', false)
    doc.commit()
    await saveDocument('ws_legacy', 'design', doc)

    const capture = captureLogsForTests('debug')
    try {
      const result = await exportCanvasHeadless({
        scope: testStoreScope(),
        workspaceId: 'ws_legacy',
        path: 'design',
      })
      expect(result.png.length).toBeGreaterThan(0)
      expect(renderSpy).toHaveBeenCalledTimes(1)
      const [canvas] = renderSpy.mock.calls[0]!
      expect(canvas.nodes).toEqual([])
      expect(capture.records.filter((r) => r.level === 'warning')).toEqual([])
    } finally {
      capture.restore()
    }
  })
})

describe('the workspace tag library reaches the export (ADR-0040 decision 5)', () => {
  const library = { health: { exclusive: true, values: { ok: { color: '4' }, failing: {} } } }
  const libraryDoc = () => {
    const doc = new LoroDoc()
    writeDocumentKind(doc, 'markdown')
    writeFacets(doc, { 'visual.tags/v0': { keys: library } } as never)
    doc.commit()
    return doc
  }
  const board = (tags?: string[]) => {
    const doc = new LoroDoc()
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({
          id: 'n1',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          text: 'api',
          ...(tags ? { tags } : {}),
        }),
      ],
      edges: [],
    })
    doc.commit()
    return doc
  }
  const optionsOf = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls[0]?.[2] as { tagLibrary?: unknown } | undefined

  it('hands the renderer the library the document at `tags` declares, for a tagged board', async () => {
    await saveDocument('ws_lib', 'tags', libraryDoc())
    await saveDocument('ws_lib', 'design', board(['health:ok']))
    await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: 'ws_lib',
      path: 'design',
    })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toEqual(library)
    await exportCanvasHeadless({ scope: testStoreScope(), workspaceId: 'ws_lib', path: 'design' })
    expect(optionsOf(renderSpy)?.tagLibrary).toEqual(library)
  })

  it('hands none when no document sits at `tags` — and creates none by asking', async () => {
    await saveDocument('ws_nolib', 'design', board(['health:ok']))
    await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: 'ws_nolib',
      path: 'design',
    })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toBeUndefined()
    // The headless read path answers a missing document with an EMPTY one,
    // which must neither stand in for a library nor leave a `tags` document.
    expect(await documentExists('ws_nolib', 'tags')).toBe(false)
  })

  it('does not read the library for a board that carries no tag', async () => {
    await saveDocument('ws_untagged', 'tags', libraryDoc())
    await saveDocument('ws_untagged', 'design', board())
    await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: 'ws_untagged',
      path: 'design',
    })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toBeUndefined()
  })
})

describe('exportCanvasHeadlessSvg', () => {
  it('renders the derived spatial canvas through renderSpatialCanvasToSvg and returns its markup', async () => {
    const doc = spatialTextDoc('n1', 'hello')
    await saveDocument('ws_svg', 'design', doc)

    const result = await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: 'ws_svg',
      path: 'design',
    })

    expect(renderSvgSpy).toHaveBeenCalledTimes(1)
    expect(result.svg).toBe('<svg><rect/></svg>')
    const [canvas] = renderSvgSpy.mock.calls[0]!
    expect(canvas.nodes.map((n) => n.id)).toEqual(['n1'])
  })
})
