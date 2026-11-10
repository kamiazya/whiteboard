import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { okfCodec } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import {
  artifactDirectory,
  coreLoaders,
  type LayoutCoreSettings,
  layoutCoreSettingsFrom,
  packagedArtifacts,
  stagedArtifacts,
} from './layout-core.js'

/** The routing factory alone, for the tests that read no OKF. */
const layoutCore = (settings: LayoutCoreSettings) => coreLoaders(settings).layoutCore

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

describe('where the daemon finds the core artifact', () => {
  const candidates = () => {
    const root = emptyDir()
    const packaged = join(root, 'packaged')
    const staged = join(root, 'staged')
    return { packaged, staged }
  }
  const withWasm = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'whiteboard_wasm_bg.wasm'), '')
  }

  it('prefers WHITEBOARD_CORE_DIR over a packaged copy over the checkout copy', () => {
    const where = candidates()
    withWasm(where.packaged)
    withWasm(where.staged)
    expect(
      artifactDirectory(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: '/elsewhere' }), where),
    ).toBe('/elsewhere')
    expect(artifactDirectory(layoutCoreSettingsFrom({}), where)).toBe(where.packaged)
  })

  it('falls back to the checkout copy when no packaged copy shipped', () => {
    const where = candidates()
    withWasm(where.staged)
    expect(artifactDirectory(layoutCoreSettingsFrom({}), where)).toBe(where.staged)
  })

  it('names the packaged directory under dist/assets, where the build copies it', () => {
    expect(packagedArtifacts()).toMatch(/dist[\\/]assets[\\/]core-wasm$/)
  })
})

describe('the daemon layout core', () => {
  it('reads rust, log and the staged artifacts when nothing is set', () => {
    expect(layoutCoreSettingsFrom({})).toEqual({
      WHITEBOARD_CORE: 'rust',
      WHITEBOARD_CORE_OKF: 'rust',
      WHITEBOARD_CORE_MISMATCH: 'log',
    })
    expect(() => layoutCoreSettingsFrom({ WHITEBOARD_CORE_OKF: 'fast' })).toThrow()
    expect(() => layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'fast' })).toThrow()
  })

  it('loads nothing under ts, the rollback setting', async () => {
    const load = layoutCore(
      layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'ts', WHITEBOARD_CORE_DIR: emptyDir() }),
    )
    expect(await load()).toBeUndefined()
  })

  it('warns with a countable event and routes in TypeScript when the default core cannot load', async () => {
    const capture = captureLogsForTests('warning')
    try {
      const settings = layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: emptyDir() })
      expect(await layoutCore(settings)()).toBeUndefined()
      expect(capture.records.filter((r) => r.data?.event === 'core-load-failed')).toHaveLength(1)
    } finally {
      capture.restore()
    }
  })

  it('warns and routes in TypeScript when the artifact cannot be read', async () => {
    const capture = captureLogsForTests('warning')
    try {
      const settings = layoutCoreSettingsFrom({
        WHITEBOARD_CORE: 'differential',
        WHITEBOARD_CORE_DIR: emptyDir(),
      })
      expect(await layoutCore(settings)()).toBeUndefined()
      expect(capture.records.map((r) => r.msg)).toContain(
        'the Rust core did not load; answering in TypeScript',
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
    await expect(layoutCore(settings)()).rejects.toThrow()
  })

  it('loads nothing for OKF under ts, the rollback', async () => {
    const settings = layoutCoreSettingsFrom({
      WHITEBOARD_CORE_OKF: 'ts',
      WHITEBOARD_CORE_DIR: emptyDir(),
    })
    expect(await coreLoaders(settings).okfCore()).toBeUndefined()
  })

  it('has the staged artifact wherever CI runs this file', () => {
    if (process.env.CI) expect(built).toBe(true)
  })

  describe.runIf(built)('over the staged artifact', () => {
    it('routes with the Rust core when nothing is set', async () => {
      const core = await layoutCore(layoutCoreSettingsFrom({}))()
      expect(core?.impl.routeLayout).toBe('rust')
    })

    it('loads once, and a differential layout over it reports nothing', async () => {
      const capture = captureLogsForTests('warning')
      try {
        const load = layoutCore(layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'differential' }))
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
      const strict = await layoutCore(
        layoutCoreSettingsFrom({
          WHITEBOARD_CORE: 'differential',
          WHITEBOARD_CORE_MISMATCH: 'throw',
        }),
      )()
      expect(() => strict?.onMismatch?.(mismatch as never)).toThrow(/layout core refused/)
      const capture = captureLogsForTests('warning')
      try {
        const lenient = await layoutCore(
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

describe.runIf(built)('the daemon OKF core over the staged artifact', () => {
  const differential = layoutCoreSettingsFrom({
    WHITEBOARD_CORE: 'differential',
    WHITEBOARD_CORE_OKF: 'differential',
  })

  it('shares one instance with the layout core', async () => {
    const loaders = coreLoaders(differential)
    const okf = await loaders.okfCore()
    const layout = await loaders.layoutCore()
    expect(okf?.impl).toEqual({ parseOkf: 'differential', serializeOkf: 'differential' })
    expect(okf?.okf).toBe(layout?.routing)
  })

  it('reads and writes a document with nothing to report', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const codec = okfCodec(await coreLoaders(differential).okfCore())
      const parsed = codec.parseOkf('---\ntype: note\ntags: [a, b]\n---\nbody\n')
      if (!parsed.ok) throw new Error(parsed.error.message)
      codec.serializeOkf(parsed.value)
      expect(capture.records).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it('throws a difference under throw and logs it otherwise', async () => {
    const differs = {
      fn: 'parseOkf' as const,
      kind: 'differs' as const,
      ts: 'a',
      rust: 'b',
      text: '',
    }
    const strict = await coreLoaders(
      layoutCoreSettingsFrom({
        WHITEBOARD_CORE_OKF: 'differential',
        WHITEBOARD_CORE_MISMATCH: 'throw',
      }),
    ).okfCore()
    expect(() => strict?.onMismatch?.(differs)).toThrow(/OKF core differs/)
    const capture = captureLogsForTests('debug')
    try {
      const lenient = await coreLoaders(
        layoutCoreSettingsFrom({ WHITEBOARD_CORE_OKF: 'rust' }),
      ).okfCore()
      lenient?.onMismatch?.(differs)
      expect(capture.records.map((r) => [r.level, r.msg])).toEqual([
        ['warning', 'the Rust core and the TypeScript disagree'],
      ])
    } finally {
      capture.restore()
    }
  })

  describe('a declined OKF call', () => {
    const declined = {
      fn: 'serializeOkf' as const,
      kind: 'declined' as const,
      err: new Error('refused: input-too-large'),
    }

    it('fails like a difference under throw', async () => {
      const strict = await coreLoaders(
        layoutCoreSettingsFrom({
          WHITEBOARD_CORE_OKF: 'differential',
          WHITEBOARD_CORE_MISMATCH: 'throw',
        }),
      ).okfCore()
      expect(() => strict?.onMismatch?.(declined)).toThrow(
        /OKF core declined: .*"fn":"serializeOkf".*input-too-large/,
      )
    })

    it('is logged as an okf-declined record with its reason and no content otherwise', async () => {
      const capture = captureLogsForTests('warning')
      try {
        const lenient = await coreLoaders(
          layoutCoreSettingsFrom({ WHITEBOARD_CORE_OKF: 'rust' }),
        ).okfCore()
        lenient?.onMismatch?.(declined)
        expect(capture.records).toHaveLength(1)
        expect(capture.records[0]).toMatchObject({
          level: 'warning',
          data: {
            event: 'okf-declined',
            fn: 'serializeOkf',
            reason: 'Error: refused: input-too-large',
          },
        })
        expect(JSON.stringify(capture.records[0])).not.toContain('"err"')
      } finally {
        capture.restore()
      }
    })
  })
})
