import type { z } from 'zod'
import type { FacetEditorSpec, FacetPickerCatalogSection } from './form.js'
import { type PluginManifest, pluginManifestSchema } from './generated/plugin-manifest.zod.js'
import {
  defineFacet,
  definePlugin,
  type FacetCompatEntry,
  type FacetDefinition,
  type FacetPlugin,
  type FacetPluginAssets,
} from './registry.js'

/**
 * A plugin as DATA (ADR-0054 decision 12): the manifest says what a plugin
 * is and how its facets are edited, and NAMES what only code can be — a
 * payload schema, a catalog loader, an asset table, a migration. The host
 * supplies those by name, here, so the manifest stays a document the Rust
 * core can read without a JavaScript engine.
 */
export interface PluginHost {
  /** Payload schemas, keyed by the `schema` pointer a facet or compat entry holds. */
  readonly schemas: Readonly<Record<string, z.ZodTypeAny>>
  /** Catalog loaders, keyed by a picker catalog's `source`. */
  readonly catalogs?: Readonly<Record<string, () => Promise<readonly FacetPickerCatalogSection[]>>>
  /** Asset tables, keyed by the name `assets` gives them. */
  readonly assets?: Readonly<
    Record<string, NonNullable<FacetPluginAssets[keyof FacetPluginAssets]>>
  >
  /** Compat migrations, keyed by a compat entry's `migrate`. */
  readonly migrations?: Readonly<Record<string, (old: unknown) => unknown>>
}

function supplied<T>(
  table: Readonly<Record<string, T>> | undefined,
  name: string,
  what: string,
): T {
  const found = table !== undefined && Object.hasOwn(table, name) ? table[name] : undefined
  if (found === undefined) {
    throw new Error(`plugin manifest names ${what} "${name}", which the host does not supply`)
  }
  return found
}

type FacetDecl = PluginManifest['facets'][number]

function editorOf(decl: FacetDecl, host: PluginHost): FacetEditorSpec | undefined {
  const editor = decl.editor
  if (editor === undefined) return undefined
  const picker = editor.picker
  return {
    ...(editor.fields === undefined ? {} : { fields: editor.fields }),
    ...(picker === undefined
      ? {}
      : {
          picker: {
            ...(picker.options === undefined ? {} : { options: picker.options }),
            ...(picker.specimenIcon === undefined ? {} : { specimenIcon: picker.specimenIcon }),
            ...(picker.layout === undefined ? {} : { layout: picker.layout }),
            ...(picker.catalog === undefined
              ? {}
              : {
                  catalog: {
                    label: picker.catalog.label,
                    load: supplied(host.catalogs, picker.catalog.source, 'catalog'),
                    ...(picker.catalog.entry === undefined ? {} : { entry: picker.catalog.entry }),
                  },
                }),
          },
        }),
  }
}

function facetOf(decl: FacetDecl, host: PluginHost): FacetDefinition {
  const compat = decl.compat
  const retained: Record<string, FacetCompatEntry> = {}
  for (const [tag, entry] of Object.entries(compat ?? {})) {
    retained[tag] = {
      schema: supplied(host.schemas, entry.schema, 'schema'),
      migrate: supplied(host.migrations, entry.migrate, 'migration'),
    }
  }
  const editor = editorOf(decl, host)
  return defineFacet({
    name: decl.name,
    displayName: decl.displayName,
    version: decl.version as `v${number}`,
    targets: decl.targets,
    schema: supplied(host.schemas, decl.schema, 'schema'),
    ...(compat === undefined ? {} : { compat: retained }),
    ...(editor === undefined ? {} : { editor }),
    ...(decl.assetRefs === undefined ? {} : { assetRefs: decl.assetRefs }),
  })
}

/**
 * Builds the plugin a manifest describes. The manifest is parsed first, then
 * handed to `defineFacet` and `definePlugin`, so every definition-time check
 * a hand-written plugin meets runs here too. A name the host does not supply
 * throws at load, naming it.
 */
export function pluginFromManifest(manifest: unknown, host: PluginHost): FacetPlugin {
  const parsed = pluginManifestSchema.parse(manifest)
  const tables = parsed.assets
  // `definePlugin` parses each table's entries against the asset schemas, so
  // the host's tables are checked there rather than trusted here.
  const assets: FacetPluginAssets | undefined =
    tables === undefined
      ? undefined
      : {
          ...(tables.themes === undefined
            ? {}
            : {
                themes: supplied(
                  host.assets,
                  tables.themes,
                  'theme table',
                ) as FacetPluginAssets['themes'],
              }),
          ...(tables.icons === undefined
            ? {}
            : {
                icons: supplied(
                  host.assets,
                  tables.icons,
                  'icon table',
                ) as FacetPluginAssets['icons'],
              }),
          ...(tables.stencils === undefined
            ? {}
            : {
                stencils: supplied(
                  host.assets,
                  tables.stencils,
                  'stencil table',
                ) as FacetPluginAssets['stencils'],
              }),
        }
  return definePlugin({
    id: parsed.id,
    displayName: parsed.displayName,
    facets: parsed.facets.map((decl) => facetOf(decl, host)),
    ...(assets === undefined ? {} : { assets }),
  })
}
