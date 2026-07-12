import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Build a minimal-but-valid PNG (signature + IHDR + IEND) so the embedding
// step that runs after rendering can find an IEND chunk. A bare 8-byte
// signature would fail the embed precondition and mask renderer-level
// assertions behind an embed-time error.
function makeMinimalPng(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  const ihdrLen = Buffer.alloc(4)
  ihdrLen.writeUInt32BE(ihdrData.length, 0)
  return Buffer.concat([
    sig,
    ihdrLen,
    Buffer.from('IHDR', 'latin1'),
    ihdrData,
    Buffer.alloc(4),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND', 'latin1'),
    Buffer.from([0xae, 0x42, 0x60, 0x82]),
  ])
}

// Replace the real renderer with a spy so we can assert the exact scene
// passed to it without paying happy-dom + canvas + resvg startup cost.
const renderSpy = vi.fn(async () => ({
  png: makeMinimalPng(),
  width: 10,
  height: 10,
}))
const renderSvgSpy = vi.fn(async () => ({
  svg: '<svg><rect/></svg>',
}))
vi.mock('./headless-renderer.js', () => ({
  renderSceneToPng: renderSpy,
  renderSceneToSvg: renderSvgSpy,
}))

// Walk PNG chunks for the integration test below. Mirrors the parser used
// in png-embed-scene.test.ts but is local to this file so the integration
// test exercises the public surface end-to-end.
function findTextChunk(png: Buffer): { keyword: string; text: string } | null {
  let pos = 8
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.subarray(pos + 4, pos + 8).toString('latin1')
    if (type === 'tEXt') {
      const data = png.subarray(pos + 8, pos + 8 + len)
      const sep = data.indexOf(0)
      return {
        keyword: data.subarray(0, sep).toString('latin1'),
        text: data.subarray(sep + 1).toString('latin1'),
      }
    }
    pos += 12 + len
  }
  return null
}

const { exportCanvasHeadless, exportCanvasHeadlessSvg } = await import('./headless-export.js')
const { saveCanvas } = await import('../store/canvas-store.js')
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

describe('exportCanvasHeadless minFontPx', () => {
  it('bumps small text fontSize up to minFontPx before handing the scene to the renderer', async () => {
    // Build a canvas with one tiny text and one large rectangle.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const text = list.insertContainer(0, new LoroMap())
    text.set('id', 'tiny-label')
    text.set('type', 'text')
    text.set('fontSize', 8)
    text.set('isDeleted', false)
    const rect = list.insertContainer(1, new LoroMap())
    rect.set('id', 'big-shape')
    rect.set('type', 'rectangle')
    rect.set('isDeleted', false)
    doc.commit()
    await saveCanvas('ws_a', 'design', doc)

    await exportCanvasHeadless({
      workspaceId: 'ws_a',
      slug: 'design',
      options: { minFontPx: 14 },
    })

    expect(renderSpy).toHaveBeenCalledTimes(1)
    const scene = renderSpy.mock.calls[0][0] as {
      elements: Array<{ id: string; type: string; fontSize?: number }>
    }
    const tiny = scene.elements.find((e) => e.id === 'tiny-label')
    const big = scene.elements.find((e) => e.id === 'big-shape')
    // The whole point of this regression: `minFontPx: 14` must reach the
    // renderer, otherwise headless exports of the same scene under
    // browser path vs no-browser path render labels at different sizes.
    expect(tiny?.fontSize).toBe(14)
    // Non-text elements are not touched.
    expect(big?.fontSize).toBeUndefined()
  })

  it('embeds the scene JSON as a tEXt chunk so the .excalidraw.png file is re-importable', async () => {
    // Recreate the same canvas the renderer-spy will see so we can compare
    // the embedded payload against the scene that actually went on disk.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const rect = list.insertContainer(0, new LoroMap())
    rect.set('id', 'r1')
    rect.set('type', 'rectangle')
    rect.set('isDeleted', false)
    doc.commit()
    await saveCanvas('ws_c', 'design', doc)

    const result = await exportCanvasHeadless({
      workspaceId: 'ws_c',
      slug: 'design',
    })

    const text = findTextChunk(result.png)
    if (!text) throw new Error('expected a tEXt chunk in the headless-export PNG')
    // The keyword has to match Excalidraw's MIME_TYPES.excalidraw verbatim
    // — anything else and `decodePngMetadata` rejects the file as having
    // no scene data.
    expect(text.keyword).toBe('application/vnd.excalidraw+json')
    const parsed = JSON.parse(text.text) as {
      type: string
      elements: Array<{ id: string; type: string }>
    }
    expect(parsed.type).toBe('excalidraw')
    expect(parsed.elements.map((e) => e.id)).toEqual(['r1'])
  })

  it('leaves text elements untouched when minFontPx is omitted', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const text = list.insertContainer(0, new LoroMap())
    text.set('id', 'tiny')
    text.set('type', 'text')
    text.set('fontSize', 8)
    text.set('isDeleted', false)
    doc.commit()
    await saveCanvas('ws_b', 'design', doc)

    await exportCanvasHeadless({
      workspaceId: 'ws_b',
      slug: 'design',
    })

    const scene = renderSpy.mock.calls[0][0] as {
      elements: Array<{ id: string; fontSize?: number }>
    }
    expect(scene.elements.find((e) => e.id === 'tiny')?.fontSize).toBe(8)
  })
})

describe('exportCanvasHeadlessSvg', () => {
  it('renders the scene through renderSceneToSvg and returns its markup', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const rect = list.insertContainer(0, new LoroMap())
    rect.set('id', 'r1')
    rect.set('type', 'rectangle')
    rect.set('isDeleted', false)
    doc.commit()
    await saveCanvas('ws_svg', 'design', doc)

    const result = await exportCanvasHeadlessSvg({ workspaceId: 'ws_svg', slug: 'design' })

    expect(renderSvgSpy).toHaveBeenCalledTimes(1)
    expect(result.svg).toBe('<svg><rect/></svg>')
    const scene = renderSvgSpy.mock.calls[0][0] as {
      elements: Array<{ id: string }>
    }
    expect(scene.elements.map((e) => e.id)).toEqual(['r1'])
  })
})
