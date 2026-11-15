import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpatialTheme, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
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
import { facetWriteCoreInstalled, installFacetWriteCore } from '@kamiazya/whiteboard-server-core'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import {
  artifactDirectory,
  coreLoaders,
  installRustCoresAtBoot,
  type LayoutCoreSettings,
  layoutCoreSettingsFrom,
  packagedArtifacts,
  RUST_FACET_PLUGIN_IDS,
  refuseFacetCoreForDeployment,
  stagedArtifacts,
} from './layout-core.js'
import { createExportTextMeasurer } from './measure-text.js'

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
      WHITEBOARD_CORE_LAYOUT: 'rust',
      WHITEBOARD_CORE_MISMATCH: 'log',
    })
    expect(() => layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'fast' })).toThrow()
    expect(() => layoutCoreSettingsFrom({ WHITEBOARD_CORE_LAYOUT: 'fast' })).toThrow()
  })

  it('loads the core when only the whole layout asks for it', async () => {
    const settings = layoutCoreSettingsFrom({
      WHITEBOARD_CORE: 'ts',
      WHITEBOARD_CORE_LAYOUT: 'differential',
      WHITEBOARD_CORE_MISMATCH: 'throw',
      WHITEBOARD_CORE_DIR: emptyDir(),
    })
    await expect(layoutCore(settings)()).rejects.toThrow()
  })

  it('loads nothing when both switches read ts, the rollback setting', async () => {
    const capture = captureLogsForTests('warning')
    try {
      const load = layoutCore(
        layoutCoreSettingsFrom({
          WHITEBOARD_CORE: 'ts',
          WHITEBOARD_CORE_LAYOUT: 'ts',
          WHITEBOARD_CORE_DIR: emptyDir(),
        }),
      )
      expect(await load()).toBeUndefined()
      expect(capture.records).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it('still asks for the core when routing alone rolls back, since the layout defaults to rust', async () => {
    const settings = layoutCoreSettingsFrom({
      WHITEBOARD_CORE: 'ts',
      WHITEBOARD_CORE_MISMATCH: 'throw',
      WHITEBOARD_CORE_DIR: emptyDir(),
    })
    await expect(layoutCore(settings)()).rejects.toThrow()
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
    it('routes and lays out with the Rust core when nothing is set', async () => {
      const core = await layoutCore(layoutCoreSettingsFrom({}))()
      expect(core?.impl).toEqual({ routeLayout: 'rust', layoutSpatialCanvas: 'rust' })
    })

    describe('under the default settings, over what the daemon hands a layout', () => {
      /** The default core, its whole-layout answers recorded as `laid out` or the decline's class. */
      async function defaultCore() {
        const core = await layoutCore(layoutCoreSettingsFrom({}))()
        if (core?.layout === undefined) throw new Error('the core has no whole layout')
        const { layout } = core
        const answers: string[] = []
        const reports: string[] = []
        const recording = {
          ...core,
          layout: {
            layoutSpatialCanvas: (r: never, highlight: never) => {
              const answer = layout.layoutSpatialCanvas(r, highlight)
              answers.push('declined' in answer ? answer.declined : 'laid out')
              return answer
            },
          },
          onMismatch: (report: Parameters<NonNullable<typeof core.onMismatch>>[0]) => {
            reports.push(
              report.kind === 'skipped' || report.kind === 'declined'
                ? `${report.kind}:${report.reason}`
                : report.kind,
            )
            core.onMismatch?.(report)
          },
        }
        const { measure } = await createExportTextMeasurer({ fontsDir: emptyDir() })
        const themed = { measure, appearance: createSpatialTheme({ mode: 'light' }) }
        return { core: recording, answers, reports, themed }
      }

      it('draws the core’s scene for an ordinary board, the TypeScript’s to the byte', async () => {
        const { core, answers, reports, themed } = await defaultCore()
        expect(layoutSpatialCanvas(board, { ...themed, core })).toEqual(
          layoutSpatialCanvas(board, themed),
        )
        expect(answers).toEqual(['laid out'])
        expect(reports).toEqual([])
      })

      it('falls back to the TypeScript for a layout the core cannot be handed, counting it', async () => {
        const capture = captureLogsForTests('warning')
        try {
          const { core, answers, reports, themed } = await defaultCore()
          // An appearance the core has no name for: the request gate skips it.
          const unnamed = { ...themed, appearance: options.appearance }
          expect(layoutSpatialCanvas(board, { ...unnamed, core })).toEqual(
            layoutSpatialCanvas(board, unnamed),
          )
          expect(answers).toEqual([])
          expect(reports).toEqual(['skipped:appearance'])
          expect(capture.records).toEqual([])
        } finally {
          capture.restore()
        }
      })

      it('falls back to the TypeScript for a layout the core declines, counting it', async () => {
        const capture = captureLogsForTests('warning')
        try {
          const { core, answers, reports, themed } = await defaultCore()
          const declined = { ...core, layout: { layoutSpatialCanvas: () => ({ declined: 'body' }) } }
          expect(layoutSpatialCanvas(board, { ...themed, core: declined as never })).toEqual(
            layoutSpatialCanvas(board, themed),
          )
          expect(answers).toEqual([])
          expect(reports).toEqual(['declined:body'])
          expect(capture.records).toEqual([])
        } finally {
          capture.restore()
        }
      })
    })

    it('lays the whole canvas out in the core when the layout switch says so', async () => {
      const core = await layoutCore(
        layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'ts', WHITEBOARD_CORE_LAYOUT: 'rust' }),
      )()
      expect(core?.impl).toEqual({ routeLayout: 'ts', layoutSpatialCanvas: 'rust' })
      if (core?.layout === undefined) throw new Error('the core has no whole layout')
      const { layout } = core
      let asked = 0
      const counting = {
        ...core,
        layout: {
          layoutSpatialCanvas: (r: never, highlight: never) => {
            asked += 1
            return layout.layoutSpatialCanvas(r, highlight)
          },
        },
      }
      const themed = { ...options, appearance: createSpatialTheme({ mode: 'light' }) }
      const reference = layoutSpatialCanvas(board, themed)
      expect(layoutSpatialCanvas(board, { ...themed, core: counting })).toEqual(reference)
      expect(asked).toBe(1)
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

    it('lays out with the vendored faces in the core, a mark the face would compose included', async () => {
      const core = await layoutCore(
        layoutCoreSettingsFrom({
          WHITEBOARD_CORE_LAYOUT: 'differential',
          WHITEBOARD_CORE_MISMATCH: 'throw',
        }),
      )()
      if (core?.layout === undefined) throw new Error('the core has no whole layout')
      const { layout } = core
      const answers: string[] = []
      const counting = {
        ...core,
        layout: {
          layoutSpatialCanvas: (r: never, highlight: never) => {
            const answer = layout.layoutSpatialCanvas(r, highlight)
            answers.push('declined' in answer ? answer.declined : 'laid out')
            return answer
          },
        },
      }
      const { measure } = await createExportTextMeasurer({ fontsDir: emptyDir() })
      const themed = { measure, appearance: createSpatialTheme({ mode: 'light' }) }
      const marked: SpatialCanvas = {
        nodes: [
          textNode({ id: 'm', x: 0, y: 0, width: 200, height: 80, text: 'cafe\u0301 i\u0307' }),
        ],
        edges: [],
      }
      for (const canvas of [board, marked]) {
        expect(layoutSpatialCanvas(canvas, { ...themed, core: counting })).toEqual(
          layoutSpatialCanvas(canvas, themed),
        )
      }
      expect(answers).toEqual(['laid out', 'laid out'])
    })

    it('summarizes a whole-layout difference by the path it parts at', async () => {
      const capture = captureLogsForTests('warning')
      try {
        const lenient = await layoutCore(
          layoutCoreSettingsFrom({ WHITEBOARD_CORE: 'differential' }),
        )()
        lenient?.onMismatch?.({
          fn: 'layoutSpatialCanvas',
          kind: 'differs',
          at: '/scene/nodes/0',
          ts: 1,
          rust: 2,
          repro: { canvas: board } as never,
        })
        expect(capture.records.map((r) => r.data)).toMatchObject([
          {
            fn: 'layoutSpatialCanvas',
            at: '/scene/nodes/0',
            ts: 1,
            rust: 2,
            nodes: board.nodes.length,
          },
        ])
      } finally {
        capture.restore()
      }
    })

    it('counts a layout the core did not answer by class, and never throws it', async () => {
      const strict = await layoutCore(
        layoutCoreSettingsFrom({
          WHITEBOARD_CORE_LAYOUT: 'differential',
          WHITEBOARD_CORE_MISMATCH: 'throw',
        }),
      )()
      const capture = captureLogsForTests('debug')
      try {
        const tallies = [
          { kind: 'skipped', reason: 'style' },
          { kind: 'declined', reason: 'body' },
          { kind: 'skipped', reason: 'style' },
        ] as const
        for (const tally of tallies) {
          expect(() => strict?.onMismatch?.({ fn: 'layoutSpatialCanvas', ...tally })).not.toThrow()
        }
        expect(
          capture.records
            .filter((r) => r.msg === 'the Rust core did not answer this layout')
            .map((r) => r.data),
        ).toMatchObject([
          { kind: 'skipped', reason: 'style', count: 1 },
          { kind: 'declined', reason: 'body', count: 1 },
          { kind: 'skipped', reason: 'style', count: 2 },
        ])
        expect(capture.records.filter((r) => r.level === 'warning')).toEqual([])
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

describe('the daemon cores, installed at boot', () => {
  // The installation is process-global; the test realm's cores are put back.
  let okfRealm: ReturnType<typeof installOkfCore>
  let spatialRealm: ReturnType<typeof installSpatialCore>
  let facetRealm: ReturnType<typeof installFacetWriteCore>
  const removeRealmCores = () => {
    okfRealm = installOkfCore(undefined)
    spatialRealm = installSpatialCore(undefined)
    facetRealm = installFacetWriteCore(undefined)
  }
  afterEach(() => {
    installOkfCore(okfRealm)
    installSpatialCore(spatialRealm)
    installFacetWriteCore(facetRealm)
  })

  it('keeps cores the realm already installed, loading nothing', async () => {
    await installRustCoresAtBoot(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: emptyDir() }))
    expect(okfCoreInstalled()).toBe(true)
    expect(spatialCoreInstalled()).toBe(true)
    expect(facetWriteCoreInstalled()).toBe(true)
    okfRealm = installOkfCore(undefined)
    installOkfCore(okfRealm)
    spatialRealm = installSpatialCore(undefined)
    installSpatialCore(spatialRealm)
    facetRealm = installFacetWriteCore(undefined)
    installFacetWriteCore(facetRealm)
  })

  it('refuses to start without the core, naming where it looked and how to build it', async () => {
    removeRealmCores()
    const dir = emptyDir()
    const boot = installRustCoresAtBoot(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: dir }))
    await expect(boot).rejects.toThrow(dir)
    await expect(boot).rejects.toThrow(/build:wasm/)
    expect(okfCoreInstalled()).toBe(false)
    expect(spatialCoreInstalled()).toBe(false)
    expect(facetWriteCoreInstalled()).toBe(false)
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
      await installRustCoresAtBoot(layoutCoreSettingsFrom({}))
      expect(okfCoreInstalled()).toBe(true)
      expect(spatialCoreInstalled()).toBe(true)
      expect(facetWriteCoreInstalled()).toBe(true)
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
    await installRustCoresAtBoot(settings)
    const bootOkf = installOkfCore(undefined)
    const bootSpatial = installSpatialCore(undefined)
    const bootFacets = installFacetWriteCore(undefined)
    // One load per directory: the routing core is the instance boot installed for both codecs.
    const layout = await coreLoaders(settings).layoutCore()
    expect(bootOkf).toBeDefined()
    expect(bootSpatial).toBe(bootOkf)
    expect(bootFacets).toBe(bootOkf)
    expect(layout?.routing).toBe(bootOkf)
  })
})

describe('the daemon facet write core', () => {
  it('holds the plugin ids of the registry the core is built from', () => {
    expect([...RUST_FACET_PLUGIN_IDS]).toEqual(bundledFacetRegistry.plugins.map((p) => p.id))
  })

  describe('boot', () => {
    const plugins = (...ids: string[]) => ({ plugins: ids.map((id) => ({ id })) }) as never

    it('serves the bundled deployment', () => {
      expect(() => refuseFacetCoreForDeployment(plugins('visual'))).not.toThrow()
    })

    it('refuses a deployment composing another plugin set, naming both', () => {
      expect(() => refuseFacetCoreForDeployment(plugins('visual', 'ticket'))).toThrow(
        /\[visual\].*\[visual, ticket\]/,
      )
      expect(() => refuseFacetCoreForDeployment(plugins())).toThrow()
    })
  })
})
