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
    await saveDocument('01TYGJP26XH16QHBBVNW85QCE0', 'design', doc)

    await exportCanvasHeadless({
      scope: testStoreScope(),
      workspaceId: '01TYGJP26XH16QHBBVNW85QCE0',
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

  it('refuses, rather than exporting an empty canvas, a doc holding entries in the retired elements list', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const rect = list.insertContainer(0, new LoroMap())
    rect.set('id', 'legacy-1')
    rect.set('type', 'rectangle')
    rect.set('isDeleted', false)
    doc.commit()
    await saveDocument('0149W95NTZ1DZPVKF0NG8BBBRH', 'design', doc)

    await expect(
      exportCanvasHeadless({
        scope: testStoreScope(),
        workspaceId: '0149W95NTZ1DZPVKF0NG8BBBRH',
        path: 'design',
      }),
    ).rejects.toThrow(/retired Excalidraw `elements` list/)
    expect(renderSpy).not.toHaveBeenCalled()
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
    await saveDocument('01Y3XV9F48P3BK66R4W49E93D4', 'tags', libraryDoc())
    await saveDocument('01Y3XV9F48P3BK66R4W49E93D4', 'design', board(['health:ok']))
    await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: '01Y3XV9F48P3BK66R4W49E93D4',
      path: 'design',
    })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toEqual(library)
    await exportCanvasHeadless({
      scope: testStoreScope(),
      workspaceId: '01Y3XV9F48P3BK66R4W49E93D4',
      path: 'design',
    })
    expect(optionsOf(renderSpy)?.tagLibrary).toEqual(library)
  })

  it('hands none when no document sits at `tags` — and creates none by asking', async () => {
    await saveDocument('01TNM0J8GGXEV9V96R9C3H5FCP', 'design', board(['health:ok']))
    await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: '01TNM0J8GGXEV9V96R9C3H5FCP',
      path: 'design',
    })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toBeUndefined()
    // The headless read path answers a missing document with an EMPTY one,
    // which must neither stand in for a library nor leave a `tags` document.
    expect(await documentExists('01TNM0J8GGXEV9V96R9C3H5FCP', 'tags')).toBe(false)
  })

  it('does not read the library for a board that carries no tag', async () => {
    await saveDocument('01D0MK07WPE105NGQT6GA5ANCF', 'tags', libraryDoc())
    await saveDocument('01D0MK07WPE105NGQT6GA5ANCF', 'design', board())
    await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: '01D0MK07WPE105NGQT6GA5ANCF',
      path: 'design',
    })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toBeUndefined()
  })
})

describe('exportCanvasHeadlessSvg', () => {
  it('renders the derived spatial canvas through renderSpatialCanvasToSvg and returns its markup', async () => {
    const doc = spatialTextDoc('n1', 'hello')
    await saveDocument('01KR4HFA5KRXT4QEFYG44FX09X', 'design', doc)

    const result = await exportCanvasHeadlessSvg({
      scope: testStoreScope(),
      workspaceId: '01KR4HFA5KRXT4QEFYG44FX09X',
      path: 'design',
    })

    expect(renderSvgSpy).toHaveBeenCalledTimes(1)
    expect(result.svg).toBe('<svg><rect/></svg>')
    const [canvas] = renderSvgSpy.mock.calls[0]!
    expect(canvas.nodes.map((n) => n.id)).toEqual(['n1'])
  })
})
