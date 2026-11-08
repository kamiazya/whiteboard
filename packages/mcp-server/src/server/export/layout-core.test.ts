import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { layoutCoreLoader, layoutCoreSettingsFrom, stagedArtifacts } from './layout-core.js'

// Where `stage:wasm` puts the artifact in this checkout. The rust job and
// test-unit restore it before this file runs, so on CI its absence is a
// failure rather than a skip.
const staged = stagedArtifacts()
const built = existsSync(join(staged, 'whiteboard_wasm_bg.wasm'))

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 120, height: 60, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 0, width: 120, height: 60, text: 'b' }),
    textNode({ id: 'c', x: 200, y: 300, width: 120, height: 60, text: 'c' }),
  ],
  edges: [
    { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'e2', from: { node: 'b' }, to: { node: 'c' } },
  ],
  facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
} as SpatialCanvas

const options = {
  measure: createFakeMeasure(),
  appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
}

let empty: string | undefined
afterEach(() => {
  if (empty !== undefined) rmSync(empty, { recursive: true, force: true })
  empty = undefined
})
const emptyDir = () => {
  empty = mkdtempSync(join(tmpdir(), 'layout-core-'))
  return empty
}

describe('the daemon layout core', () => {
  it('reads ts, log and the staged artifacts when nothing is set', () => {
    expect(layoutCoreSettingsFrom({})).toEqual({
      WHITEBOARD_CORE: 'ts',
      WHITEBOARD_CORE_MISMATCH: 'log',
    })
    expect(() => layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'fast' })).toThrow()
  })

  it('loads nothing under ts', async () => {
    const load = layoutCoreLoader(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: emptyDir() }))
    expect(await load()).toBeUndefined()
  })

  it('warns and routes in TypeScript when the artifact cannot be read', async () => {
    const capture = captureLogsForTests('warning')
    try {
      const settings = layoutCoreSettingsFrom({
        WHITEBOARD_CORE: 'differential',
        WHITEBOARD_CORE_DIR: emptyDir(),
      })
      expect(await layoutCoreLoader(settings)()).toBeUndefined()
      expect(capture.records.map((r) => r.msg)).toContain(
        'the Rust core did not load; routing in TypeScript',
      )
    } finally {
      capture.restore()
    }
  })

  it('fails instead when mismatches throw: a test that asked for the core compared nothing', async () => {
    const settings = layoutCoreSettingsFrom({
      WHITEBOARD_CORE: 'differential',
      WHITEBOARD_CORE_MISMATCH: 'throw',
      WHITEBOARD_CORE_DIR: emptyDir(),
    })
    await expect(layoutCoreLoader(settings)()).rejects.toThrow()
  })

  it('has the staged artifact wherever CI runs this file', () => {
    if (process.env.CI) expect(built).toBe(true)
  })

  describe.runIf(built)('over the staged artifact', () => {
    it('loads once, and a differential layout over it reports nothing', async () => {
      const capture = captureLogsForTests('warning')
      try {
        const load = layoutCoreLoader(layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'differential' }))
        const core = await load()
        expect(core?.impl.routeLayout).toBe('differential')
        expect(await load()).toBe(core)
        const reference = layoutSpatialCanvas(board, options)
        expect(layoutSpatialCanvas(board, { ...options, ...(core ? { core } : {}) })).toEqual(
          reference,
        )
        expect(capture.records).toEqual([])
      } finally {
        capture.restore()
      }
    })

    it('throws a reported mismatch when the settings say so, and only logs it otherwise', async () => {
      const mismatch = {
        fn: 'routeLayout' as const,
        kind: 'refused' as const,
        err: new Error('x'),
        repro: { nodes: [], edges: [], styles: [], overrides: undefined, budget: {}, labels: [] },
      }
      const strict = await layoutCoreLoader(
        layoutCoreSettingsFrom({
          WHITEBOARD_CORE: 'differential',
          WHITEBOARD_CORE_MISMATCH: 'throw',
        }),
      )()
      expect(() => strict?.onMismatch?.(mismatch as never)).toThrow(/layout core refused/)
      const capture = captureLogsForTests('warning')
      try {
        const lenient = await layoutCoreLoader(
          layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'differential' }),
        )()
        lenient?.onMismatch?.(mismatch as never)
        expect(capture.records.map((r) => r.msg)).toEqual([
          'the Rust core and the TypeScript disagree',
        ])
      } finally {
        capture.restore()
      }
    })
  })
})
