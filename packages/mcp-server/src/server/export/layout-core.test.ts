import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import {
  installOkfCore,
  installSpatialCore,
  okfCoreInstalled,
  parseOkf,
  parseSpatial,
  serializeOkf,
  serializeSpatial,
  spatialCoreInstalled,
} from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import {
  artifactDirectory,
  coreLoaders,
  installCodecCoresAtBoot,
  type LayoutCoreSettings,
  layoutCoreSettingsFrom,
  packagedArtifacts,
  RUST_FACET_PLUGIN_IDS,
  refuseFacetCoreForDeployment,
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
      WHITEBOARD_CORE_FACETS: 'ts',
      WHITEBOARD_CORE_MISMATCH: 'log',
    })
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

describe('the daemon codec cores, installed at boot', () => {
  // The installation is process-global; the test realm's cores are put back.
  let okfRealm: ReturnType<typeof installOkfCore>
  let spatialRealm: ReturnType<typeof installSpatialCore>
  const removeRealmCores = () => {
    okfRealm = installOkfCore(undefined)
    spatialRealm = installSpatialCore(undefined)
  }
  afterEach(() => {
    installOkfCore(okfRealm)
    installSpatialCore(spatialRealm)
  })

  it('keeps cores the realm already installed, loading nothing', async () => {
    await installCodecCoresAtBoot(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: emptyDir() }))
    expect(okfCoreInstalled()).toBe(true)
    expect(spatialCoreInstalled()).toBe(true)
    okfRealm = installOkfCore(undefined)
    installOkfCore(okfRealm)
    spatialRealm = installSpatialCore(undefined)
    installSpatialCore(spatialRealm)
  })

  it('refuses to start without the core, naming where it looked and how to build it', async () => {
    removeRealmCores()
    const dir = emptyDir()
    const boot = installCodecCoresAtBoot(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: dir }))
    await expect(boot).rejects.toThrow(dir)
    await expect(boot).rejects.toThrow(/build:wasm/)
    expect(okfCoreInstalled()).toBe(false)
    expect(spatialCoreInstalled()).toBe(false)
    // No fallback answers in the core's place: a call stays a loud failure.
    expect(() => parseOkf('---\ntype: note\n---\nb')).toThrow(/before this realm installed/)
    expect(() => parseSpatial('{}')).toThrow(/before this realm installed/)
    expect(() => serializeSpatial({ nodes: [], edges: [] }, 'extended')).toThrow(
      /before this realm installed/,
    )
  })

  it.runIf(built)(
    'installs the staged core, which reads and writes through the plain exports',
    async () => {
      removeRealmCores()
      await installCodecCoresAtBoot(layoutCoreSettingsFrom({}))
      expect(okfCoreInstalled()).toBe(true)
      expect(spatialCoreInstalled()).toBe(true)
      const parsed = parseOkf('---\ntype: note\ntags: [a, b]\n---\nbody\n')
      if (!parsed.ok) throw new Error(parsed.error.message)
      expect(serializeOkf(parsed.value)).toContain('tags:')
      const canvas = parseSpatial(
        '{"nodes":[{"id":"a","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}],"edges":[]}',
      )
      if (!canvas.ok) throw new Error(canvas.error.message)
      expect(JSON.parse(serializeSpatial(canvas.value, 'strict')).nodes).toHaveLength(1)
    },
  )

  it.runIf(built)('shares one wasm instance with the layout core', async () => {
    removeRealmCores()
    const settings = layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'rust' })
    await installCodecCoresAtBoot(settings)
    const bootOkf = installOkfCore(undefined)
    const bootSpatial = installSpatialCore(undefined)
    // One load per directory: the routing core is the instance boot installed for both codecs.
    const layout = await coreLoaders(settings).layoutCore()
    expect(bootOkf).toBeDefined()
    expect(bootSpatial).toBe(bootOkf)
    expect(layout?.routing).toBe(bootOkf)
  })
})

describe('the daemon facet write core', () => {
  const facetCore = (env: Record<string, string>) =>
    coreLoaders(layoutCoreSettingsFrom(env)).facetWriteCore

  it('reads WHITEBOARD_CORE_FACETS as ts unless something sets it, and refuses an unknown value', () => {
    expect(layoutCoreSettingsFrom({}).WHITEBOARD_CORE_FACETS).toBe('ts')
    expect(layoutCoreSettingsFrom({ WHITEBOARD_CORE_FACETS: 'rust' }).WHITEBOARD_CORE_FACETS).toBe(
      'rust',
    )
    expect(() => layoutCoreSettingsFrom({ WHITEBOARD_CORE_FACETS: 'fast' })).toThrow()
  })

  it('loads nothing under ts', async () => {
    expect(await facetCore({ WHITEBOARD_CORE_DIR: emptyDir() })()).toBeUndefined()
  })

  it.runIf(built)('serves the staged core under differential, once', async () => {
    const load = facetCore({ WHITEBOARD_CORE_FACETS: 'differential' })
    const core = await load()
    expect(core?.impl.partitionFacetWrites).toBe('differential')
    expect(await load()).toBe(core)
  })

  it.runIf(built)(
    'throws a reported difference when the settings say so, and only logs it otherwise',
    async () => {
      const difference = {
        fn: 'partitionFacetWrites' as const,
        kind: 'differs' as const,
        ts: 'a',
        rust: 'b',
        target: 'node' as const,
        bucket: undefined,
      }
      const strict = await facetCore({
        WHITEBOARD_CORE_FACETS: 'differential',
        WHITEBOARD_CORE_MISMATCH: 'throw',
      })()
      expect(() => strict?.onMismatch?.(difference)).toThrow(/facet write core differs/)
      const capture = captureLogsForTests('warning')
      try {
        const lenient = await facetCore({ WHITEBOARD_CORE_FACETS: 'differential' })()
        lenient?.onMismatch?.(difference)
        lenient?.onMismatch?.({
          fn: 'partitionFacetWrites',
          kind: 'declined',
          err: new Error('too large'),
        })
        expect(capture.records.map((r) => r.data?.event ?? r.msg)).toEqual([
          'the Rust core and the TypeScript disagree',
          'facets-declined',
        ])
      } finally {
        capture.restore()
      }
    },
  )

  it('holds the plugin ids of the registry the core is built from', () => {
    expect([...RUST_FACET_PLUGIN_IDS]).toEqual(bundledFacetRegistry.plugins.map((p) => p.id))
  })

  describe('boot', () => {
    const settings = (facets: string) => layoutCoreSettingsFrom({ WHITEBOARD_CORE_FACETS: facets })

    it('serves the bundled deployment under every setting', () => {
      for (const facets of ['ts', 'differential', 'rust']) {
        expect(() => refuseFacetCoreForDeployment(settings(facets), ['visual'])).not.toThrow()
      }
    })

    it.each([
      'differential',
      'rust',
    ])('refuses under %s a deployment composing another plugin set, naming both', (facets) => {
      expect(() => refuseFacetCoreForDeployment(settings(facets), ['visual', 'ticket'])).toThrow(
        /\[visual\].*\[visual, ticket\].*WHITEBOARD_CORE_FACETS=ts/,
      )
      expect(() => refuseFacetCoreForDeployment(settings(facets), [])).toThrow()
    })

    it('lets any deployment through under ts, which judges nothing in Rust', () => {
      expect(() => refuseFacetCoreForDeployment(settings('ts'), ['ticket'])).not.toThrow()
    })
  })
})
