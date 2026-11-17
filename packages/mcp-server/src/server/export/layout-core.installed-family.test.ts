// A daemon with a family the user installed (ADR-0012) hands the Rust core the
// faces it measures with, the installed ones beside the vendored four, so a
// canvas drawn in that family is laid out by the core exactly as the
// TypeScript lays it out. A face the core's reader cannot read is dropped
// when it is registered (owner decision q81, D7g): the core still lays the
// board out, declares that family nowhere, and reports it as `font-missing`,
// which the export logs as a warning while the board draws in Roboto.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, describe, expect, it } from 'vitest'
import { syntheticFont, woffOf } from '../../shared/test-utils/synthetic-font.js'
import { captureLogsForTests } from '../log.js'
import { fontsDir as installedFontsDir } from '../tenant/data-layout.js'
import { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } from './headless-renderer.js'
import { coreLoaders, layoutCoreSettingsFrom, stagedArtifacts } from './layout-core.js'

const built = existsSync(join(stagedArtifacts(), 'whiteboard_wasm_bg.wasm'))

// Wraps where the installed face's full-em glyphs are painted, not where Roboto's would be.
const TEXT = 'xxxx xxxx xxxx'
// One glyph per code point: the fixture gives a glyph per CHARACTER, and a cmap
// repeating one is a face opentype.js reads and the core's reader refuses.
const CARRIED = 'x '

const sketched: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 200, height: 200, text: TEXT })],
  edges: [],
  facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
}

const madeDirs: string[] = []
afterAll(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

/** A fonts directory holding `files`, by name. */
async function fontsDirWith(files: Record<string, Buffer>): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), 'wb-core-family-'))
  madeDirs.push(data)
  const dir = installedFontsDir(data)
  await mkdir(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes)
  return dir
}

/** The core, each layout's faces and answer recorded. */
async function recordingCore() {
  const core = await coreLoaders(layoutCoreSettingsFrom({})).layoutCore()
  const { layout } = core
  const faces: string[][] = []
  const answers: string[] = []
  const recording = {
    ...core,
    layout: {
      layoutSpatialCanvas: (request: never, highlight: never, own: never) => {
        const { measure } = request as { measure: { faces?: Record<string, unknown>[] } }
        faces.push((measure.faces ?? []).map((f) => `${f.family} ${f.bold} ${f.italic}`))
        const answer = layout.layoutSpatialCanvas(request, highlight, own)
        answers.push('refused' in answer ? `refused:${answer.refused.code}` : 'laid out')
        return answer
      },
    },
  }
  return { core: recording, faces, answers }
}

const ROBOTO = ['Roboto false false', 'Roboto true false', 'Roboto false true', 'Roboto true true']

describe.runIf(built)('a family the user installed, under the Rust layout', () => {
  it('reaches the core beside the vendored faces, and draws what the TypeScript draws', async () => {
    const fontsDir = await fontsDirWith({
      'a-yomogi.ttf': syntheticFont(CARRIED, 'Yomogi'),
      // Same family later in the directory: the first file is the face, as for resvg.
      'b-yomogi.ttf': syntheticFont('x', 'Yomogi'),
      // The vendored family's four faces are not replaced by one installed file.
      'c-roboto.otf': syntheticFont('x', 'Roboto'),
    })
    const { core, faces, answers } = await recordingCore()
    const options = { style: 'document' } as const

    const svg = await renderSpatialCanvasToSvg(sketched, fontsDir, { ...options, core })
    const png = await renderSpatialCanvasToPng(sketched, fontsDir, { ...options, core })

    expect(answers).toEqual(['laid out', 'laid out'])
    expect(faces[0]).toEqual([...ROBOTO, 'Yomogi false false'])
    expect(svg.svg).toContain('font-family="Yomogi"')
    // The same export through a core that records nothing: the recording wrapper changes no byte.
    const plain = { ...options, core: testLayoutCore() }
    expect(svg.svg).toBe((await renderSpatialCanvasToSvg(sketched, fontsDir, plain)).svg)
    expect(png.png.equals((await renderSpatialCanvasToPng(sketched, fontsDir, plain)).png)).toBe(
      true,
    )
  })

  it.each([
    ['a WOFF under a .ttf name', woffOf(syntheticFont(CARRIED, 'Yomogi'))],
    ['a cmap that repeats a code point', syntheticFont(TEXT, 'Yomogi')],
    [
      'a face past the core’s 32 MiB per face',
      Buffer.concat([syntheticFont(CARRIED, 'Yomogi'), Buffer.alloc(32 * 1024 * 1024 + 1)]),
    ],
  ])('lays out with %s dropped, drawn in Roboto and reported missing', async (_, bytes) => {
    const fontsDir = await fontsDirWith({ 'yomogi.ttf': bytes })
    const { core, faces, answers } = await recordingCore()
    const capture = captureLogsForTests('debug')
    try {
      const svg = await renderSpatialCanvasToSvg(sketched, fontsDir, { style: 'document', core })
      await renderSpatialCanvasToSvg(sketched, fontsDir, { style: 'document', core })

      // The core answers; it was handed the face, and dropped it itself.
      expect(answers).toEqual(['laid out', 'laid out'])
      expect(faces[0]).toEqual([...ROBOTO, 'Yomogi false false'])
      // The theme's family is declared nowhere: the board is drawn in the vendored faces.
      expect(svg.svg).not.toContain('font-family="Yomogi"')
      expect(svg.svg).toMatch(/font-family="Roboto[",]/)
      const missing = capture.records.filter(
        (r) =>
          r.msg ===
          'theme names a font family this export cannot measure; declaring the bundled one',
      )
      expect(missing.map((r) => [r.level, r.data])).toEqual([
        ['warning', { family: 'Yomogi' }],
        ['warning', { family: 'Yomogi' }],
      ])
      expect(capture.records.filter((r) => r.level === 'warning')).toHaveLength(2)
    } finally {
      capture.restore()
    }
  })

  it('hands the core only the faces one registration holds, so more families than that still lay out', async () => {
    // Past the registration's 64 faces the core would refuse the whole set and
    // every layout with it; the daemon keeps the first families that fit instead.
    const files = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => {
        const family = `Family${String(i).padStart(2, '0')}`
        return [`${family}.ttf`, syntheticFont(CARRIED, family)]
      }),
    )
    const fontsDir = await fontsDirWith(files)
    const { core, faces, answers } = await recordingCore()

    await renderSpatialCanvasToSvg(sketched, fontsDir, { style: 'document', core })

    expect(answers).toEqual(['laid out'])
    expect(faces[0]).toHaveLength(64)
    expect(faces[0]?.slice(0, 4)).toEqual(ROBOTO)
  })
})
