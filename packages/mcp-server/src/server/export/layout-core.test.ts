import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpatialTheme, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
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
import type { Core } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import {
  facetWriteCoreInstalled,
  installFacetWriteCore,
  installSearchCore,
  searchCoreInstalled,
} from '@kamiazya/whiteboard-server-core'
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
  it('reads the staged artifacts when nothing is set, and nothing but where they are', () => {
    expect(layoutCoreSettingsFrom({})).toEqual({})
    // The retired switches are no settings any more: setting one changes nothing.
    expect(
      layoutCoreSettingsFrom({
        WHITEBOARD_CORE: 'ts',
        WHITEBOARD_CORE_LAYOUT: 'ts',
        WHITEBOARD_CORE_MISMATCH: 'throw',
      }),
    ).toEqual({})
  })

  it('rejects when the artifact cannot be read, since nothing answers in its place', async () => {
    const capture = captureLogsForTests('warning')
    try {
      const settings = layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: emptyDir() })
      await expect(layoutCore(settings)()).rejects.toThrow()
    } finally {
      capture.restore()
    }
  })

  it('has the staged artifact wherever CI runs this file', () => {
    if (process.env.CI) expect(built).toBe(true)
  })

  describe.runIf(built)('over the staged artifact', () => {
    it('hands every layout entry the one instance, loaded once', async () => {
      const load = layoutCore(layoutCoreSettingsFrom({}))
      const core = await load()
      expect(core.layout).toBe(core.routing)
      expect(core.markdown).toBe(core.routing)
      expect(core.query).toBe(core.routing)
      expect((await load()).routing).toBe(core.routing)
    })

    /** The core, its whole-layout answers recorded as `laid out` or the refusal's code. */
    async function recordingCore() {
      const core = await layoutCore(layoutCoreSettingsFrom({}))()
      const answers: string[] = []
      const recording = {
        ...core,
        layout: {
          layoutSpatialCanvas: (r: never, highlight: never, measure: never) => {
            const answer = core.layout.layoutSpatialCanvas(r, highlight, measure)
            answers.push('refused' in answer ? answer.refused.code : 'laid out')
            return answer
          },
        },
      }
      return { core: recording, answers }
    }

    it('draws the core’s scene for an ordinary board, the TypeScript’s to the byte', async () => {
      const { core, answers } = await recordingCore()
      const { measure } = await createExportTextMeasurer({ fontsDir: emptyDir() })
      const themed = { measure, appearance: createSpatialTheme({ mode: 'light' }) }
      expect(layoutSpatialCanvas(board, { ...themed, core })).toEqual(
        layoutSpatialCanvas(board, { ...themed, core: testLayoutCore() }),
      )
      expect(answers).toEqual(['laid out'])
    })

    it('lays out with the vendored faces in the core, a mark the face would compose included', async () => {
      const { core, answers } = await recordingCore()
      const { measure } = await createExportTextMeasurer({ fontsDir: emptyDir() })
      const themed = { measure, appearance: createSpatialTheme({ mode: 'light' }) }
      const marked: SpatialCanvas = {
        nodes: [
          textNode({ id: 'm', x: 0, y: 0, width: 200, height: 80, text: 'cafe\u0301 i\u0307' }),
        ],
        edges: [],
      }
      for (const canvas of [board, marked]) {
        expect(layoutSpatialCanvas(canvas, { ...themed, core })).toEqual(
          layoutSpatialCanvas(canvas, { ...themed, core: testLayoutCore() }),
        )
      }
      expect(answers).toEqual(['laid out', 'laid out'])
    })

    it('throws for a layout the core cannot be handed, rather than answering in TypeScript', async () => {
      const { core, answers } = await recordingCore()
      // An appearance the core has no name for: no request carries it.
      expect(() => layoutSpatialCanvas(board, { ...options, core })).toThrow(/appearance/)
      expect(answers).toEqual([])
    })
  })
})

describe('the daemon cores, installed at boot', () => {
  // The installation is process-global; the test realm's cores are put back.
  let okfRealm: ReturnType<typeof installOkfCore>
  let spatialRealm: ReturnType<typeof installSpatialCore>
  let facetRealm: ReturnType<typeof installFacetWriteCore>
  let searchRealm: ReturnType<typeof installSearchCore>
  const removeRealmCores = () => {
    searchRealm = installSearchCore(undefined)
    okfRealm = installOkfCore(undefined)
    spatialRealm = installSpatialCore(undefined)
    facetRealm = installFacetWriteCore(undefined)
  }
  afterEach(() => {
    installOkfCore(okfRealm)
    installSpatialCore(spatialRealm)
    installFacetWriteCore(facetRealm)
    installSearchCore(searchRealm)
  })

  it('keeps cores the realm already installed, loading nothing', async () => {
    await installRustCoresAtBoot(layoutCoreSettingsFrom({ WHITEBOARD_CORE_DIR: emptyDir() }))
    expect(okfCoreInstalled()).toBe(true)
    expect(spatialCoreInstalled()).toBe(true)
    expect(facetWriteCoreInstalled()).toBe(true)
    expect(searchCoreInstalled()).toBe(true)
    searchRealm = installSearchCore(undefined)
    installSearchCore(searchRealm)
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
    expect(searchCoreInstalled()).toBe(false)
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
      expect(searchCoreInstalled()).toBe(true)
      expect(installSearchCore(undefined)?.foldForSearch('Café')).toBe('cafe')
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
    const settings = layoutCoreSettingsFrom({})
    await installRustCoresAtBoot(settings)
    const bootOkf = installOkfCore(undefined)
    const bootSpatial = installSpatialCore(undefined)
    const bootFacets = installFacetWriteCore(undefined)
    const bootSearch = installSearchCore(undefined)
    // One load per directory: the routing core is the instance boot installed for both codecs.
    const layout = await coreLoaders(settings).layoutCore()
    expect(bootOkf).toBeDefined()
    expect(bootSpatial).toBe(bootOkf)
    expect(bootFacets).toBe(bootOkf)
    expect(bootSearch).toBe((bootOkf as Core).search)
    expect(layout.routing).toBe(bootOkf)
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
