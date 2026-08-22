import { bundledFacetRegistry, type FacetTarget } from '@kamiazya/whiteboard-facet-engine'
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
// The engine's own target set — not a wider guess. `workspace` and `edge`
// are reserved in ADR-0013 but not implemented, and publishing them here
// would advertise a write no registry can accept.
const facetTargetSchema = z.enum(['document', 'canvas', 'node'])

export const facetListInputSchema = z
  .object({
    /** Keeps only facets whose declared targets include this one. */
    target: facetTargetSchema.optional(),
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
  })
  .strict()
export type FacetListOutput = z.infer<typeof facetListOutputSchema>

export function createFacetListTool(deps: ServerDeps) {
  return {
    name: 'wb_facet_list' as const,
    description:
      'List the facets this deployment registered: the exact key to write, the owning plugin, which objects each may be attached to, and the payload schema. Optionally filtered to one target.',
    inputSchema: facetListInputSchema,
    outputSchema: facetListOutputSchema,
    execute: async (input: FacetListInput): Promise<FacetListOutput> => {
      // Parsed HERE, not only at the MCP boundary: that boundary registers
      // `inputSchema.shape`, so the SDK rebuilds a non-strict validator and
      // a typo'd key would be stripped rather than refused — answering an
      // unfiltered list that looks like a result. A direct server-core
      // caller has no boundary at all.
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
      return { facets }
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
