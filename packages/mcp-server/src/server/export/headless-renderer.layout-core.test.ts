// The file export lays a board out through the same core switch as
// `wb_scene_render` (ADR-0054 step 7): under `rust` the Rust core answers the
// layout, a document style included, and `WHITEBOARD_CORE_LAYOUT=ts` never
// asks the core for a layout. Either way the
// bytes are the TypeScript's, in both export modes.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } from './headless-renderer.js'
import { coreLoaders, layoutCoreSettingsFrom, stagedArtifacts } from './layout-core.js'
import { NO_INSTALLED_FONTS } from './test-utils/no-installed-fonts.js'

// The rust job and test-unit stage the artifact before this file runs, so on
// CI its absence is a failure rather than a skip.
const built = existsSync(join(stagedArtifacts(), 'whiteboard_wasm_bg.wasm'))

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g', x: -40, y: -60, width: 700, height: 460, label: 'Release' }),
    textNode({
      id: 'plan',
      x: 0,
      y: 0,
      width: 260,
      height: 200,
      text: '# Plan\n\n- **ship** the core\n- keep `ts` as the rollback\n\n```ts\nconst answer = 42\n```',
    }),
    textNode({
      id: 'wrap',
      x: 380,
      y: 0,
      width: 200,
      height: 90,
      text: 'A longer sentence that has to wrap across the width of its box',
    }),
    textNode({ id: 'done', x: 200, y: 300, width: 180, height: 60, text: 'Done' }),
  ],
  edges: [
    { id: 'e1', from: { node: 'plan' }, to: { node: 'wrap' }, label: 'feeds' },
    { id: 'e2', from: { node: 'wrap' }, to: { node: 'done' } },
  ],
}

/** The core the settings load, with every whole-layout call and every report it makes counted. */
async function countedCore(env: Record<string, string>) {
  const base = await coreLoaders(layoutCoreSettingsFrom(env)).layoutCore()
  if (base === undefined) throw new Error('the core did not load')
  const seen = { layouts: 0, reports: [] as CoreMismatch[] }
  const layout = base.layout
  const core: LayoutCore = {
    ...base,
    ...(layout === undefined
      ? {}
      : {
          layout: {
            layoutSpatialCanvas: (request, highlight, measure) => {
              seen.layouts += 1
              return layout.layoutSpatialCanvas(request, highlight, measure)
            },
          },
        }),
    onMismatch: (mismatch) => seen.reports.push(mismatch),
  }
  return { core, seen }
}

const RUST = { WHITEBOARD_CORE_LAYOUT: 'rust', WHITEBOARD_CORE_MISMATCH: 'throw' }

describe.runIf(built)('the file export through the layout core', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`under rust the core lays the ${theme} export out, to the TypeScript's SVG bytes`, async () => {
      const { core, seen } = await countedCore(RUST)
      const ts = await renderSpatialCanvasToSvg(board, NO_INSTALLED_FONTS, { theme })
      const rust = await renderSpatialCanvasToSvg(board, NO_INSTALLED_FONTS, { theme, core })
      expect(seen).toEqual({ layouts: 1, reports: [] })
      expect(rust.svg).toBe(ts.svg)
    })

    it(`under rust the core lays the ${theme} PNG out, to the TypeScript's PNG bytes`, async () => {
      const { core, seen } = await countedCore(RUST)
      const ts = await renderSpatialCanvasToPng(board, NO_INSTALLED_FONTS, { theme, scale: 2 })
      const rust = await renderSpatialCanvasToPng(board, NO_INSTALLED_FONTS, {
        theme,
        scale: 2,
        core,
      })
      expect(seen).toEqual({ layouts: 1, reports: [] })
      expect(Buffer.compare(rust.png, ts.png)).toBe(0)
    })
  }

  it("under rust the core lays a document-style export out, to the TypeScript's bytes", async () => {
    const { core, seen } = await countedCore(RUST)
    const options = { style: 'document' as const, theme: 'dark' as const }
    const ts = await renderSpatialCanvasToSvg(board, NO_INSTALLED_FONTS, options)
    const rust = await renderSpatialCanvasToSvg(board, NO_INSTALLED_FONTS, { ...options, core })
    expect(seen).toEqual({ layouts: 1, reports: [] })
    expect(rust.svg).toBe(ts.svg)
  })

  it('WHITEBOARD_CORE_LAYOUT=ts never asks the core for a layout', async () => {
    const { core, seen } = await countedCore({ ...RUST, WHITEBOARD_CORE_LAYOUT: 'ts' })
    const ts = await renderSpatialCanvasToSvg(board, NO_INSTALLED_FONTS, { theme: 'dark' })
    const rolledBack = await renderSpatialCanvasToSvg(board, NO_INSTALLED_FONTS, {
      theme: 'dark',
      core,
    })
    expect(seen).toEqual({ layouts: 0, reports: [] })
    expect(rolledBack.svg).toBe(ts.svg)
  })

  it('repeated exports hand the core the vendored faces once', async () => {
    const dir = stagedArtifacts()
    const glue = (await import(pathToFileURL(join(dir, 'whiteboard_wasm.js')).href)) as CoreGlue
    const registered: number[] = []
    const counted: CoreGlue = {
      ...glue,
      register_layout_fonts: (bytes, faces) => {
        registered.push(bytes.byteLength)
        return glue.register_layout_fonts(bytes, faces)
      },
    }
    const layout = coreFrom(counted, await readFile(join(dir, 'whiteboard_wasm_bg.wasm')))
    const reports: CoreMismatch[] = []
    const core: LayoutCore = {
      routing: layout,
      layout,
      impl: { routeLayout: 'ts', layoutSpatialCanvas: 'rust' },
      onMismatch: (mismatch) => reports.push(mismatch),
    }
    for (const theme of ['light', 'dark', 'light'] as const) {
      await renderSpatialCanvasToSvg(board, NO_INSTALLED_FONTS, { theme, core })
    }
    expect(reports).toEqual([])
    expect(registered).toHaveLength(1)
    expect(registered[0]).toBeGreaterThan(1_000_000)
  })
})
