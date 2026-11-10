import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FACET_NAMESPACED_ID_PATTERN, FACET_SEGMENT_PATTERN } from './facet-grammar.js'
import { FACET_GLYPH_SHAPES } from './form.js'
import {
  facetVersionSchema,
  glyphShapeNameSchema,
  hostRefSchema,
  pluginManifestSchema,
  schemaRefSchema,
  segmentSchema,
} from './generated/plugin-manifest.zod.js'
import { pluginFromManifest } from './manifest.js'
import { createFacetRegistry, defineFacet } from './registry.js'
import type { IconAsset } from './theme-tokens.js'

const SCHEMA = 'facets/demo/demo.schema.json#/$defs/DemoMark'
const OLD_SCHEMA = 'facets/demo/demo.schema.json#/$defs/DemoMarkOld'

const markSchema = z.object({ tone: z.enum(['calm', 'loud']) })
const oldMarkSchema = z.object({ loudness: z.number() })
const loadSections = async () => [{ label: 'All', options: [] }]

const manifest = {
  id: 'demo',
  displayName: 'Demo',
  facets: [
    {
      name: 'mark',
      displayName: 'Mark',
      version: 'v1',
      targets: ['node', 'edge'],
      schema: SCHEMA,
      editor: {
        picker: {
          options: [
            { payload: null, label: 'No mark', glyph: { kind: 'shape', name: 'none' } },
            { payload: { tone: 'calm' }, label: 'Calm', keywords: ['quiet'] },
          ],
          layout: 'cards',
          catalog: {
            label: 'Search marks',
            source: 'demo.marks',
            entry: { label: 'Any tone', payload: {}, field: 'tone' },
          },
        },
      },
      compat: { v0: { schema: OLD_SCHEMA, migrate: 'demo.v0-to-v1' } },
    },
  ],
}

const host = {
  schemas: { [SCHEMA]: markSchema, [OLD_SCHEMA]: oldMarkSchema },
  catalogs: { 'demo.marks': loadSections },
  migrations: {
    'demo.v0-to-v1': (old: unknown) => ({
      tone: (old as { loudness: number }).loudness > 5 ? 'loud' : 'calm',
    }),
  },
}

describe('pluginFromManifest', () => {
  it('builds the plugin the manifest describes, with the host supplying what is named', () => {
    const plugin = pluginFromManifest(manifest, host)
    expect(plugin.id).toBe('demo')
    const [facet] = plugin.facets
    expect(facet?.targets).toEqual(['node', 'edge'])
    expect(facet?.schema).toBe(markSchema)
    expect(facet?.editor?.picker?.catalog?.load).toBe(loadSections)
    expect(facet?.editor?.picker?.catalog?.entry).toEqual({
      label: 'Any tone',
      payload: {},
      field: 'tone',
    })
    expect(facet?.editor?.picker?.layout).toBe('cards')
  })

  it('reads a null payload as the absence option and keeps the others', () => {
    const picker = pluginFromManifest(manifest, host).facets[0]?.editor?.picker
    expect(picker?.options?.map((option) => option.payload)).toEqual([null, { tone: 'calm' }])
    expect(picker?.options?.[1]?.keywords).toEqual(['quiet'])
  })

  it('migrates an older payload through the compat entry the manifest names', () => {
    const registry = createFacetRegistry([pluginFromManifest(manifest, host)])
    expect(registry.resolveFacetPayload('demo.mark/v0', { loudness: 9 })).toEqual({
      kind: 'resolved',
      value: { tone: 'loud' },
    })
  })

  it.each([
    ['a payload schema', { ...host, schemas: {} }, SCHEMA],
    ['a retained schema', { ...host, schemas: { [SCHEMA]: markSchema } }, OLD_SCHEMA],
    ['a catalog', { ...host, catalogs: {} }, 'demo.marks'],
    ['a migration', { ...host, migrations: {} }, 'demo.v0-to-v1'],
  ])('throws at load, naming it, when the host supplies no %s', (_what, partial, name) => {
    expect(() => pluginFromManifest(manifest, partial)).toThrow(name)
  })

  it('throws for an asset table the host does not supply', () => {
    const withAssets = { ...manifest, assets: { themes: 'demo.themes' } }
    expect(() => pluginFromManifest(withAssets, host)).toThrow('demo.themes')
  })

  it('registers the asset table the host supplies under the kind the manifest gives it', () => {
    const icons: Record<string, IconAsset> = {
      dot: { geometry: [{ tag: 'circle', cx: 12, cy: 12, r: 2 }] },
    }
    const plugin = pluginFromManifest(
      { ...manifest, assets: { icons: 'demo.icons' } },
      { ...host, assets: { 'demo.icons': icons } },
    )
    expect(plugin.assets?.icons).toBe(icons)
    expect(createFacetRegistry([plugin]).iconAsset('demo.dot')).toBeDefined()
  })

  it('refuses a manifest key nothing declares, at every level', () => {
    expect(() => pluginFromManifest({ ...manifest, extra: 1 }, host)).toThrow()
    const facet = { ...manifest.facets[0], extra: 1 }
    expect(() => pluginFromManifest({ ...manifest, facets: [facet] }, host)).toThrow()
    const editor = { picker: { layout: 'cards', extra: 1 } }
    expect(() =>
      pluginFromManifest({ ...manifest, facets: [{ ...manifest.facets[0], editor }] }, host),
    ).toThrow()
  })

  it('runs the definition-time checks of a hand-written plugin', () => {
    const noTargets = { ...manifest, facets: [{ ...manifest.facets[0], targets: [] }] }
    expect(() => pluginFromManifest(noTargets, host)).toThrow()
    const badRef = { ...manifest.facets[0], assetRefs: { absent: 'themes' }, compat: undefined }
    expect(() => pluginFromManifest({ ...manifest, facets: [badRef] }, host)).toThrow(
      /assetRefs names field "absent"/,
    )
    expect(() => pluginFromManifest({ ...manifest, id: 'workspace' }, host)).toThrow(/reserved/)
  })
})

describe('the plugin manifest schema', () => {
  it('requires the payload of a picker option, which null says is absence', () => {
    const option = { label: 'No mark' }
    const bad = { picker: { options: [option] } }
    const decl = { ...manifest.facets[0], editor: bad }
    expect(pluginManifestSchema.safeParse({ ...manifest, facets: [decl] }).success).toBe(false)
  })

  it('takes a segment, version tag and schema pointer only in their grammar', () => {
    const parse = (patch: object) =>
      pluginManifestSchema.safeParse({
        ...manifest,
        facets: [{ ...manifest.facets[0], ...patch }],
      }).success
    expect(parse({})).toBe(true)
    expect(parse({ name: 'Mark' })).toBe(false)
    expect(parse({ version: '1' })).toBe(false)
    expect(parse({ schema: 'demo.schema.json#/$defs/X' })).toBe(false)
    expect(parse({ compat: { latest: { schema: SCHEMA, migrate: 'demo.step' } } })).toBe(false)
  })
})

describe('the manifest contract restates the engine grammar', () => {
  const samples = ['visual', 'a', 'a-b', 'x1', 'A', '1a', '-a', 'a.b', 'a_b', '', 'a\n', 'v0', 'é']

  it('holds a segment to FACET_SEGMENT_PATTERN', () => {
    for (const sample of samples) {
      expect(segmentSchema.safeParse(sample).success, sample).toBe(
        FACET_SEGMENT_PATTERN.test(sample),
      )
    }
  })

  it('holds a host reference to FACET_NAMESPACED_ID_PATTERN', () => {
    for (const sample of [...samples, 'visual.symbols', 'a.b.c', 'a.', '.b', 'A.b']) {
      expect(hostRefSchema.safeParse(sample).success, sample).toBe(
        FACET_NAMESPACED_ID_PATTERN.test(sample),
      )
    }
  })

  it('holds a version tag to the one defineFacet admits', () => {
    for (const sample of ['v0', 'v12', 'v', '0', 'V0', 'v-1', 'v0x', '', 'v0\n']) {
      const admitted = (() => {
        try {
          defineFacet({
            name: 'mark',
            displayName: 'Mark',
            version: sample as `v${number}`,
            targets: ['node'],
            schema: z.object({}),
          })
          return true
        } catch {
          return false
        }
      })()
      expect(facetVersionSchema.safeParse(sample).success, sample).toBe(admitted)
    }
  })

  it('names exactly the silhouettes the engine can draw', () => {
    expect(glyphShapeNameSchema.options).toEqual([...FACET_GLYPH_SHAPES])
  })

  it('takes a schema pointer only as a definition of a contract file', () => {
    const good = 'facets/visual/visual.schema.json#/$defs/VisualShapeFacet'
    expect(schemaRefSchema.safeParse(good).success).toBe(true)
    for (const bad of [
      '',
      'visual.schema.json#/$defs/X',
      `${good}1`,
      `${good}\n`,
      good.replace('$defs', 'defs'),
    ]) {
      expect(schemaRefSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})
