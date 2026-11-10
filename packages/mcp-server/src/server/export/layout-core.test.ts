import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import {
  installOkfCore,
  okfCoreInstalled,
  parseOkf,
  serializeOkf,
  spatialCodec,
} from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import {
  artifactDirectory,
  coreLoaders,
  installOkfCoreAtBoot,
  type LayoutCoreSettings,
  layoutCoreSettingsFrom,
  packagedArtifacts,
  stagedArtifacts,
} from './layout-core.js'

/** The routing factory alone. */
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
      WHITEBOARD_CORE_SPATIAL: 'rust',
      WHITEBOARD_CORE_MISMATCH: 'log',
    })
    expect(() => layoutCoreSettingsFrom({ WHITEBOARD_CORE_SPATIAL: 'fast' })).toThrow()
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

  it('loads nothing for JSON Canvas under ts, the rollback', async () => {
    const settings = layoutCoreSettingsFrom({
      WHITEBOARD_CORE_SPATIAL: 'ts',
      WHITEBOARD_CORE_DIR: emptyDir(),
    })
    expect(await coreLoaders(settings).spatialCore()).toBeUndefined()
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

describe('the daemon OKF core, installed at boot', () => {
  // The installation is process-global; the test realm's core is put back.
  let realm: ReturnType<typeof installOkfCore>
  afterEach(() => installOkfCore(realm))

  it('keeps a core the realm already installed, loading nothing', async () => {
    realm = installOkfCore(undefined)
    installOkfCore(realm)
    await installOkfCoreAtBoot(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: emptyDir() }))
    expect(okfCoreInstalled()).toBe(true)
  })

  it('refuses to start without the core, naming where it looked and how to build it', async () => {
    realm = installOkfCore(undefined)
    const dir = emptyDir()
    const boot = installOkfCoreAtBoot(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: dir }))
    await expect(boot).rejects.toThrow(dir)
    await expect(boot).rejects.toThrow(/build:wasm/)
    expect(okfCoreInstalled()).toBe(false)
    // No fallback answers in the core's place: an OKF call stays a loud failure.
    expect(() => parseOkf('---\ntype: note\n---\nb')).toThrow(/before this realm installed/)
  })

  it.runIf(built)(
    'installs the staged core, which reads and writes through the plain exports',
    async () => {
      realm = installOkfCore(undefined)
      await installOkfCoreAtBoot(layoutCoreSettingsFrom({}))
      expect(okfCoreInstalled()).toBe(true)
      const parsed = parseOkf('---\ntype: note\ntags: [a, b]\n---\nbody\n')
      if (!parsed.ok) throw new Error(parsed.error.message)
      expect(serializeOkf(parsed.value)).toContain('tags:')
    },
  )

  it.runIf(built)('shares one wasm instance with the layout core', async () => {
    realm = installOkfCore(undefined)
    const settings = layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'rust' })
    await installOkfCoreAtBoot(settings)
    const bootCore = installOkfCore(undefined)
    // One load per directory: the routing core is the instance boot installed for OKF.
    const layout = await coreLoaders(settings).layoutCore()
    expect(bootCore).toBeDefined()
    expect(layout?.routing).toBe(bootCore)
  })
})

describe.runIf(built)('the daemon JSON Canvas core over the staged artifact', () => {
  const differential = layoutCoreSettingsFrom({
    WHITEBOARD_CORE: 'differential',
    WHITEBOARD_CORE_SPATIAL: 'differential',
  })

  it('shares its instance with the layout core', async () => {
    const loaders = coreLoaders(differential)
    const spatial = await loaders.spatialCore()
    const layout = await loaders.layoutCore()
    expect(spatial?.impl).toEqual({
      parseSpatial: 'differential',
      serializeSpatial: 'differential',
    })
    expect(spatial?.spatial).toBe(layout?.routing)
  })

  it('reads and writes a canvas in both modes with nothing to report', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const codec = spatialCodec(await coreLoaders(differential).spatialCore())
      const text =
        '{"nodes":[{"id":"a","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}],"edges":[]}'
      const parsed = codec.parseSpatial(text)
      if (!parsed.ok) throw new Error(parsed.error.message)
      codec.serializeSpatial(parsed.value, 'extended')
      codec.serializeSpatial(parsed.value, 'strict')
      expect(capture.records).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it('throws a difference or a decline under throw, and logs a decline as spatial-declined otherwise', async () => {
    const differs = {
      fn: 'parseSpatial' as const,
      kind: 'differs' as const,
      ts: 'a',
      rust: 'b',
      text: '',
    }
    const declined = {
      fn: 'serializeSpatial' as const,
      kind: 'declined' as const,
      err: new Error('refused: input-too-large'),
    }
    const strict = await coreLoaders(
      layoutCoreSettingsFrom({
        WHITEBOARD_CORE_SPATIAL: 'differential',
        WHITEBOARD_CORE_MISMATCH: 'throw',
      }),
    ).spatialCore()
    expect(() => strict?.onMismatch?.(differs)).toThrow(/JSON Canvas core differs/)
    expect(() => strict?.onMismatch?.(declined)).toThrow(
      /JSON Canvas core declined: .*"fn":"serializeSpatial".*input-too-large/,
    )
    const capture = captureLogsForTests('warning')
    try {
      const lenient = await coreLoaders(
        layoutCoreSettingsFrom({ WHITEBOARD_CORE_SPATIAL: 'rust' }),
      ).spatialCore()
      lenient?.onMismatch?.(declined)
      expect(capture.records).toHaveLength(1)
      expect(capture.records[0]).toMatchObject({
        level: 'warning',
        data: {
          event: 'spatial-declined',
          fn: 'serializeSpatial',
          reason: 'Error: refused: input-too-large',
        },
      })
    } finally {
      capture.restore()
    }
  })
})
