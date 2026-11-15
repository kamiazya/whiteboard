import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSpatialTheme } from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { exportLayoutOptions } from '../../src/server/export/headless-renderer.js'
import {
  coreLoaders,
  layoutCoreSettingsFrom,
  stagedArtifacts,
} from '../../src/server/export/layout-core.js'
import { censusOf, tallyingCore } from './layout-census.mjs'

// The rust job and test-unit stage the artifact before this file runs, so on
// CI its absence is a failure rather than a skip.
const built = existsSync(join(stagedArtifacts(), 'whiteboard_wasm_bg.wasm'))

const board = (text: string) => ({
  nodes: [textNode({ id: 'n', x: 0, y: 0, width: 200, height: 100, text })],
  edges: [],
})

describe('the layout census', () => {
  it('has the staged artifact wherever CI runs this file', () => {
    if (process.env.CI) expect(built).toBe(true)
  })

  it.runIf(built)(
    'counts what the core answered, what it declined and what the gate skipped',
    async () => {
      const base = await coreLoaders(
        layoutCoreSettingsFrom({ WHITEBOARD_CORE_LAYOUT: 'differential' }),
      ).layoutCore()
      if (base === undefined) throw new Error('the core did not load')
      const options = {
        measure: createFakeMeasure(),
        appearance: createSpatialTheme({ mode: 'light' }),
      }
      const cases = [
        { canvas: board('plain words'), options },
        {
          canvas: {
            nodes: [textNode({ id: 'n', x: Infinity, y: 0, width: 200, height: 100, text: 'x' })],
            edges: [],
          },
          options,
        },
        { canvas: board('plain words'), options: { ...options, renderMath: () => undefined } },
        { canvas: board('more plain words'), options },
      ]
      const { layouts, counts } = censusOf(tallyingCore(base), cases)
      expect(layouts).toBe(4)
      expect(Object.fromEntries(counts)).toEqual({
        answered: 2,
        'declined:non-finite': 1,
        'skipped:seam:renderMath': 1,
      })
    },
  )

  it.runIf(built)("the file export's options are answered by the core in both modes", async () => {
    const base = await coreLoaders(
      layoutCoreSettingsFrom({ WHITEBOARD_CORE_LAYOUT: 'differential' }),
    ).layoutCore()
    if (base === undefined) throw new Error('the core did not load')
    const measure = createFakeMeasure()
    const cases = (['light', 'dark'] as const).map((mode) => ({
      canvas: board('exported words'),
      options: exportLayoutOptions(measure, mode, undefined, () => true),
    }))
    const { layouts, counts } = censusOf(tallyingCore(base), cases)
    expect(layouts).toBe(2)
    expect(Object.fromEntries(counts)).toEqual({ answered: 2 })
  })

  it.runIf(built)('a board carrying proposals is answered by the core, not skipped', async () => {
    const base = await coreLoaders(
      layoutCoreSettingsFrom({ WHITEBOARD_CORE_LAYOUT: 'differential' }),
    ).layoutCore()
    if (base === undefined) throw new Error('the core did not load')
    const proposals = [
      {
        id: 'p',
        changes: [
          { id: 'c', status: 'open', op: 'node.patch', nodeId: 'n', patch: { x: 40 }, assumed: {} },
        ],
      },
    ] as const
    const options = {
      measure: createFakeMeasure(),
      appearance: createSpatialTheme({ mode: 'light' }),
      proposals,
    }
    const { counts } = censusOf(tallyingCore(base), [{ canvas: board('proposed'), options }])
    expect(Object.fromEntries(counts)).toEqual({ answered: 1 })
  })
})
