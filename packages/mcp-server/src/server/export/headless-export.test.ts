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

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const renderSpy = vi.fn(async () => ({
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  width: 10,
  height: 10,
}))
const renderSvgSpy = vi.fn(async () => ({
  svg: '<svg><rect/></svg>',
}))
vi.mock('./headless-renderer.js', () => ({
  renderSpatialCanvasToPng: renderSpy,
  renderSpatialCanvasToSvg: renderSvgSpy,
}))

const { exportCanvasHeadless, exportCanvasHeadlessSvg, _hasLegacyElementsForTests } = await import(
  './headless-export.js'
)
const { saveDocument, documentExists } = await import('../store/document-store.js')
const { clearCache } = await import('../store/doc-cache.js')

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-headless-export-test-'))
  clearCache()
  renderSpy.mockClear()
  renderSvgSpy.mockClear()
})

afterEach(async () => {
  clearCache()
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
      workspaceId: 'ws_a',
      path: 'design',
      options: { padding: 20, scale: 2, theme: 'dark', frameId: 'ignored', minFontPx: 99 },
    })

    expect(renderSpy).toHaveBeenCalledTimes(1)
    const [canvas, options] = renderSpy.mock.calls[0] as [
      { nodes: Array<{ id: string }> },
      { padding?: number; scale?: number; theme?: string },
    ]
    expect(canvas.nodes.map((n) => n.id)).toEqual(['n1'])
    expect(options).toEqual({ padding: 20, scale: 2, theme: 'dark' })
  })

  it('accepts frameId and minFontPx without changing renderer output (both are ignored)', async () => {
    const doc = spatialTextDoc('n1', 'hello')
    await saveDocument('ws_ignored', 'design', doc)

    await exportCanvasHeadless({ workspaceId: 'ws_ignored', path: 'design' })
    const withoutIgnored = renderSpy.mock.calls[0][1]

    await exportCanvasHeadless({
      workspaceId: 'ws_ignored',
      path: 'design',
      options: { frameId: 'frame-1', minFontPx: 42 },
    })
    const withIgnored = renderSpy.mock.calls[1][1]

    expect(withIgnored).toEqual(withoutIgnored)
  })

  it('logs a warning and returns a valid empty export for a doc with legacy Excalidraw elements but no spatial nodes', async () => {
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
      const result = await exportCanvasHeadless({ workspaceId: 'ws_legacy', path: 'design' })
      expect(result.png.length).toBeGreaterThan(0)
      expect(renderSpy).toHaveBeenCalledTimes(1)
      const [canvas] = renderSpy.mock.calls[0] as [{ nodes: unknown[] }]
      expect(canvas.nodes).toEqual([])

      const warnings = capture.records.filter(
        (r) =>
          r.level === 'warning' &&
          r.msg.includes('legacy Excalidraw elements') &&
          r.data?.workspaceId === 'ws_legacy' &&
          r.data?.path === 'design',
      )
      expect(warnings).toHaveLength(1)
    } finally {
      capture.restore()
    }
  })

  it('does not create a legacy elements container as a side effect of probing a normal doc', async () => {
    // Exercised directly against a bare LoroDoc (not via loadDocument), so
    // this is isolated from document-store's own, separate legacy-list
    // migration probe on the load path.
    const doc = new LoroDoc()
    const nodes = doc.getMap('nodes')
    nodes.set('n1', textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: 'hi' }))
    doc.commit()

    expect(_hasLegacyElementsForTests(doc)).toBe(false)
    // getMovableList('elements') would create the container as a side
    // effect of the mere call — getShallowValue() reflects only containers
    // that actually exist, so this is the non-mutating way to assert the
    // probe left no trace.
    expect(Object.keys(doc.getShallowValue())).not.toContain('elements')
  })

  it('detects legacy elements without mutating a doc that already has them', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const rect = list.insertContainer(0, new LoroMap())
    rect.set('id', 'legacy-1')
    doc.commit()
    const snapshotBefore = doc.export({ mode: 'snapshot' })

    expect(_hasLegacyElementsForTests(doc)).toBe(true)

    const snapshotAfter = doc.export({ mode: 'snapshot' })
    expect(Buffer.from(snapshotAfter).equals(Buffer.from(snapshotBefore))).toBe(true)
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
    spy.mock.calls[0]?.[1] as { tagLibrary?: unknown } | undefined

  it('hands the renderer the library the document at `tags` declares, for a tagged board', async () => {
    await saveDocument('ws_lib', 'tags', libraryDoc())
    await saveDocument('ws_lib', 'design', board(['health:ok']))
    await exportCanvasHeadlessSvg({ workspaceId: 'ws_lib', path: 'design' })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toEqual(library)
    await exportCanvasHeadless({ workspaceId: 'ws_lib', path: 'design' })
    expect(optionsOf(renderSpy)?.tagLibrary).toEqual(library)
  })

  it('hands none when no document sits at `tags` — and creates none by asking', async () => {
    await saveDocument('ws_nolib', 'design', board(['health:ok']))
    await exportCanvasHeadlessSvg({ workspaceId: 'ws_nolib', path: 'design' })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toBeUndefined()
    // The headless read path answers a missing document with an EMPTY one,
    // so the library lookup must probe existence first or every export
    // would mint a `tags` document.
    expect(await documentExists('ws_nolib', 'tags')).toBe(false)
  })

  it('does not read the library for a board that carries no tag', async () => {
    await saveDocument('ws_untagged', 'tags', libraryDoc())
    await saveDocument('ws_untagged', 'design', board())
    await exportCanvasHeadlessSvg({ workspaceId: 'ws_untagged', path: 'design' })
    expect(optionsOf(renderSvgSpy)?.tagLibrary).toBeUndefined()
  })
})

describe('exportCanvasHeadlessSvg', () => {
  it('renders the derived spatial canvas through renderSpatialCanvasToSvg and returns its markup', async () => {
    const doc = spatialTextDoc('n1', 'hello')
    await saveDocument('ws_svg', 'design', doc)

    const result = await exportCanvasHeadlessSvg({ workspaceId: 'ws_svg', path: 'design' })

    expect(renderSvgSpy).toHaveBeenCalledTimes(1)
    expect(result.svg).toBe('<svg><rect/></svg>')
    const [canvas] = renderSvgSpy.mock.calls[0] as [{ nodes: Array<{ id: string }> }]
    expect(canvas.nodes.map((n) => n.id)).toEqual(['n1'])
  })
})
