/**
 * What the bundled plugin DECLARES, projected to plain data and pinned by
 * snapshot: per facet its key, targets, asset refs, editor (a catalog's
 * loader named rather than serialised) and the JSON Schema of its payload;
 * and the asset tables by digest. The projection is the contract between
 * the plugin and everything that reads its registration, whatever form the
 * definition is written in.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bundledFacetRegistry, VISUAL_HOST, visualPlugin } from './data.js'
import { symbolCatalogLoad } from './editors.js'
import * as generated from './generated/visual.zod.js'
import { VISUAL_STENCILS } from './stencils.js'
import { VISUAL_THEMES } from './themes.js'
import manifest from './visual.manifest.json' with { type: 'json' }

const CATALOG_LOADER = '<catalog loader>'

function withMarkedCatalog(editor: NonNullable<(typeof visualPlugin.facets)[number]['editor']>) {
  const catalog = editor.picker?.catalog
  if (catalog === undefined) return editor
  return { ...editor, picker: { ...editor.picker, catalog: { ...catalog, load: CATALOG_LOADER } } }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

describe('the visual plugin definition', () => {
  it('declares these facets, each with its targets, asset refs, editor and payload schema', () => {
    const projection = visualPlugin.facets.map((facet) => ({
      key: `${visualPlugin.id}.${facet.name}/${facet.version}`,
      displayName: facet.displayName,
      targets: facet.targets,
      assetRefs: facet.assetRefs ?? null,
      compat: Object.keys(facet.compat ?? {}),
      editor: facet.editor === undefined ? null : withMarkedCatalog(facet.editor),
      schema: z.toJSONSchema(facet.schema),
    }))
    expect({
      id: visualPlugin.id,
      displayName: visualPlugin.displayName,
      facets: projection,
    }).toMatchSnapshot()
  })

  it('registers the asset tables the data modules hold', () => {
    const assets = visualPlugin.assets
    expect(assets?.themes).toEqual(VISUAL_THEMES)
    expect(assets?.stencils).toEqual(VISUAL_STENCILS)
    expect(Object.keys(assets?.icons ?? {}).length).toBeGreaterThan(20)
    expect(digest(assets?.icons)).toMatchSnapshot()
  })

  it('loads the symbol catalog through the one loader', () => {
    const symbol = visualPlugin.facets.find((facet) => facet.name === 'symbol')
    expect(symbol?.editor?.picker?.catalog?.load).toBe(symbolCatalogLoad)
  })

  it('declares every facet the registry knows, and the registry knows every one it declares', () => {
    const declared = manifest.facets.map((facet) => `${manifest.id}.${facet.name}/${facet.version}`)
    const registered = bundledFacetRegistry.plugins.flatMap((plugin) =>
      plugin.facets.map((facet) => `${plugin.id}.${facet.name}/${facet.version}`),
    )
    expect(declared.length).toBeGreaterThan(10)
    expect([...declared].sort()).toEqual([...registered].sort())
  })

  it('declares an asset table for every asset kind the registry holds', () => {
    const kinds = ['themes', 'icons', 'stencils'] as const
    const held = kinds.filter((kind) => bundledFacetRegistry.assetIds(kind).length > 0)
    expect(held).toEqual(['themes', 'icons', 'stencils'])
    expect(Object.keys(manifest.assets).sort()).toEqual([...held].sort())
  })

  it('supplies each pointer the generated schema of the definition it names', () => {
    const pointers = Object.entries(VISUAL_HOST.schemas)
    expect(pointers.length).toBe(manifest.facets.length)
    for (const [pointer, schema] of pointers) {
      const definition = pointer.split('#/$defs/')[1] ?? ''
      const exported = `${definition.charAt(0).toLowerCase()}${definition.slice(1)}Schema`
      expect(Object.keys(generated), pointer).toContain(exported)
      expect((generated as Record<string, unknown>)[exported], pointer).toBe(schema)
    }
  })
})
