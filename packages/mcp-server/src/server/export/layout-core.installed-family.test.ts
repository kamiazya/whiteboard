// A daemon with a family the user installed (ADR-0012) hands the Rust core the
// faces it measures with, the installed ones beside the vendored four, so a
// canvas drawn in that family is laid out by the core exactly as the
// TypeScript lays it out. A face the core's reader cannot read declines the
// whole layout to the TypeScript, at debug level and never as a disagreement.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** The core under the strictest settings, each layout's faces and answer recorded. */
async function recordingCore() {
  const settings = layoutCoreSettingsFrom({
    WHITEBOARD_CORE_LAYOUT: 'rust',
    WHITEBOARD_CORE_MISMATCH: 'throw',
  })
  const core = await coreLoaders(settings).layoutCore()
  if (core?.layout === undefined) throw new Error('the core has no whole layout')
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
        answers.push('declined' in answer ? `declined:${answer.declined}` : 'laid out')
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
    expect(svg.svg).toBe((await renderSpatialCanvasToSvg(sketched, fontsDir, options)).svg)
    expect(png.png.equals((await renderSpatialCanvasToPng(sketched, fontsDir, options)).png)).toBe(
      true,
    )
  })

  it.each([
    ['a WOFF under a .ttf name', woffOf(syntheticFont(CARRIED, 'Yomogi')), 'font'],
    ['a cmap that repeats a code point', syntheticFont(TEXT, 'Yomogi'), 'font'],
    [
      'a face past the core’s 32 MiB per face',
      Buffer.concat([syntheticFont(CARRIED, 'Yomogi'), Buffer.alloc(32 * 1024 * 1024 + 1)]),
      'face',
    ],
  ])('stays with the TypeScript for %s, reported at debug level', async (_, bytes, reason) => {
    const fontsDir = await fontsDirWith({ 'yomogi.ttf': bytes })
    const { core, answers } = await recordingCore()
    const capture = captureLogsForTests('debug')
    try {
      const svg = await renderSpatialCanvasToSvg(sketched, fontsDir, { style: 'document', core })
      await renderSpatialCanvasToSvg(sketched, fontsDir, { style: 'document', core })

      expect(answers).toEqual([`declined:${reason}`, `declined:${reason}`])
      expect(svg.svg).toContain('font-family="Yomogi"')
      expect(svg.svg).toBe(
        (await renderSpatialCanvasToSvg(sketched, fontsDir, { style: 'document' })).svg,
      )
      const unanswered = capture.records.filter(
        (r) => r.msg === 'the Rust core did not answer this layout',
      )
      expect(unanswered.map((r) => r.data)).toMatchObject([
        { kind: 'declined', reason, count: 1 },
        { kind: 'declined', reason, count: 2 },
      ])
      expect(capture.records.filter((r) => r.level === 'warning')).toEqual([])
    } finally {
      capture.restore()
    }
  })
})
