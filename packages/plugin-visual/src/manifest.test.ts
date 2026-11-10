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
import { visualPlugin } from './data.js'
import { SYMBOL_CATALOG } from './editors.js'
import { VISUAL_STENCILS } from './stencils.js'
import { VISUAL_THEMES } from './themes.js'

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
    expect(symbol?.editor?.picker?.catalog?.load).toBe(SYMBOL_CATALOG.load)
  })
})
