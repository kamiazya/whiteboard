import type { FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'

/**
 * What facets this deployment registered, so an agent can DISCOVER a key
 * instead of guessing one. `wb_facet_set` validates a registered payload
 * against its schema and its declared targets, and until this tool existed
 * the only way to learn either was to read the source or fail a write.
 *
 * Read-only and deployment-scoped: the answer describes the registry, not
 * any document, so it takes no workspace or document id.
 */
// The engine's own target set — not a wider guess. `workspace` is reserved
// in ADR-0013 but not implemented, and publishing it here would advertise a
// write no registry can accept.
const facetTargetSchema = z.enum(['document', 'canvas', 'node', 'edge'])

/**
 * The engine's asset kinds (ADR-0013 decision 3). Restated here for the same
 * reason `facetTargetSchema` is: this tool publishes a vocabulary, and an
 * answer naming a kind the engine does not have would advertise a lookup
 * nothing can serve.
 */
const assetKindSchema = z.enum(['themes', 'icons', 'stencils'])

export const facetListInputSchema = z
  .object({
    /** Keeps only facets whose declared targets include this one. */
    target: facetTargetSchema.optional(),
    /**
     * Keeps only assets of this kind. It narrows the ASSETS and leaves the
     * facets alone — the two halves answer different questions, and a
     * filter that silently emptied the other would read as "this
     * deployment has none".
     */
    assetKind: assetKindSchema
      .optional()
      .describe('Keeps only assets of this kind. The facets are unaffected.'),
  })
  .strict()
export type FacetListInput = z.infer<typeof facetListInputSchema>

export const facetListOutputSchema = z
  .object({
    facets: z.array(
      z
        .object({
          /** The exact key a write must use — `{namespace}.{name}/v{n}`. */
          key: z.string(),
          namespace: z.string(),
          /** The owning plugin's human-facing name. */
          displayName: z.string(),
          name: z.string(),
          version: z.string(),
          targets: z.array(facetTargetSchema),
          /**
           * The payload contract as JSON Schema — what makes the answer
           * actionable rather than a list of names to guess against.
           *
           * OPTIONAL, because a schema JSON Schema cannot express degrades
           * to nothing: `JSON.stringify` drops an undefined value's key
           * entirely, and a non-optional `z.unknown()` rejects the absent
           * key, so the tool would answer with a payload violating its own
           * output contract exactly when it degraded.
           */
          schema: z.unknown().optional(),
        })
        .strict(),
    ),
    /**
     * Registered ASSETS — the named vocabulary a document REFERS to rather
     * than carries: stencils, themes, icon sets (ADR-0013 decision 3,
     * ADR-0034 decision 4).
     *
     * Here rather than enumerated in the schema of whichever tool consumes
     * them, and that is measured: an enum of stencil ids costs
     * `wb_canvas_edit` ~38 bytes per stencil per op on EVERY turn — +4838
     * at 120 stencils, 13% of the whole tool table — for a vocabulary most
     * conversations never touch. A library is meant to GROW, so a cost that
     * grows with it is the wrong shape. This answer costs nothing until
     * somebody asks.
     */
    assets: z.array(
      z
        .object({
          /** The exact id a write must use — `{plugin}.{name}`. */
          id: z.string(),
          kind: assetKindSchema,
          /** The owning plugin's id, which is the id's first segment. */
          namespace: z.string(),
          /**
           * What to call it on screen. Present only where the asset itself
           * declares one — a stencil does, a theme and an icon do not — and
           * omitted rather than faked from the id, since a guessed label is
           * a worse answer than none.
           */
          displayName: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict()
export type FacetListOutput = z.infer<typeof facetListOutputSchema>

export function createFacetListTool(deps: ServerDeps) {
  return {
    name: 'wb_facet_list' as const,
    description:
      'List what this deployment registered: facets (the exact key to write, the owning plugin, which objects each may be attached to, the payload schema) and assets (the stencil, theme and icon ids a write names by id). Optionally filtered to one target or one asset kind.',
    inputSchema: facetListInputSchema,
    outputSchema: facetListOutputSchema,
    execute: async (input: FacetListInput): Promise<FacetListOutput> => {
      // Parsed HERE, not only at the MCP boundary: a direct server-core
      // caller has no boundary at all, and a typo'd key stripped rather
      // than refused would answer an unfiltered list that looks like a
      // result. (The MCP boundary itself is strict now — every tool
      // registers the Zod object rather than its `.shape` — but this
      // parse is what holds the line for the other callers.)
      const parsed = facetListInputSchema.parse(input)
      const registry = deps.facetRegistry ?? bundledFacetRegistry
      const facets = registry.plugins
        .flatMap((plugin) =>
          plugin.facets.map((definition) => ({
            key: `${plugin.id}.${definition.name}/${definition.version}`,
            namespace: plugin.id,
            displayName: plugin.displayName,
            name: definition.name,
            version: definition.version as string,
            targets: [...definition.targets] as FacetTarget[],
            // z.toJSONSchema can refuse a schema it cannot express (a
            // transform, say). A facet whose contract cannot be published
            // still belongs in the list — the key and targets are useful
            // on their own — so the schema degrades rather than the entry.
            schema: describeSchema(definition.schema),
          })),
        )
        .filter((facet) => parsed.target === undefined || facet.targets.includes(parsed.target))
        // Sorted by key so two calls agree and a diff of the output is
        // stable; registration order is an implementation detail.
        .sort((a, b) => (a.key < b.key ? -1 : 1))

      // NOT sorted, unlike the facets: registration order is what a reader
      // wants here — the bundled vocabulary first, then what this
      // deployment added — and an id sort would interleave a community
      // pack's entries through the built-ins.
      const assets = (['themes', 'icons', 'stencils'] as const)
        .filter((kind) => parsed.assetKind === undefined || kind === parsed.assetKind)
        .flatMap((kind) =>
          registry.assetIds(kind).map((id) => ({
            id,
            kind,
            namespace: id.slice(0, id.indexOf('.')),
            ...(kind === 'stencils' ? { displayName: registry.stencilAsset(id)?.displayName } : {}),
          })),
        )
      return { facets, assets }
    },
  }
}

function describeSchema(schema: z.ZodTypeAny): unknown {
  try {
    return z.toJSONSchema(schema)
  } catch {
    return undefined
  }
}
