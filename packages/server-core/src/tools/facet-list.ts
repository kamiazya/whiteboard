import type { FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { computeTagsInUse, tagInUseSchema } from './document-tags.js'
import { listWorkspaceDocuments, workspaceFacetRegistry } from './stencil-library.js'

/**
 * What facets this deployment registered, so an agent can DISCOVER a key
 * instead of guessing one. `wb_facet_set` validates a registered payload
 * against its schema and its declared targets, and until this tool existed
 * the only way to learn either was to read the source or fail a write.
 *
 * Read-only. The answer describes a REGISTRY rather than any document, so
 * it needs no ids — except that a workspace's own stencil library is
 * content, and the only registry that holds it is the one composed for
 * that workspace. `workspaceId` is how a caller asks for that one; without
 * it the answer is the deployment's alone, and costs no lookup.
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
    /**
     * Described to pay C3, and NOT to steer: a clause telling the caller
     * that filtering to `node` hides the board-wide scope was measured over
     * three trials and changed nothing — the model filtered to `node` in all
     * three, before and after, and the axis it needed stayed unseen
     * (ADR-0031's fourteenth reading). The steering clause was withdrawn and
     * the plain meaning kept, because a parameter a caller picks from an
     * enum of four should say what it does either way.
     *
     * What the reading pointed at instead was structural, and this tool's
     * own history said it confidently: a join the ANSWER carries is not a
     * sentence a model may or may not act on. That was built (`otherTargets`
     * below) and MEASURED, and it is not true as a general remedy — round
     * 17 read 0 of 3 with `colour contested` three times, unmoved, and two
     * of those trials had the join in front of them. Carrying a fact in the
     * answer makes it unmissable; it does not make a model act on it.
     */
    target: facetTargetSchema
      .optional()
      .describe('Keeps only facets whose declared targets include this one.'),
    /**
     * Keeps only assets of this kind. It narrows the ASSETS and leaves the
     * facets alone — the two halves answer different questions, and a
     * filter that silently emptied the other would read as "this
     * deployment has none".
     */
    assetKind: assetKindSchema
      .optional()
      .describe('Keeps only assets of this kind. The facets are unaffected.'),
    /**
     * Opt-in, and it buys the one thing this tool could not answer: the
     * stencils a WORKSPACE defines in its own library document
     * (ADR-0034 decision 4). Omitted, nothing is read from the workspace at
     * all — finding a library is a listing plus a document read, and a
     * caller asking what the deployment registered must not pay for it.
     */
    workspaceId: z
      .string()
      .optional()
      .describe(
        'Also list the stencils this workspace defines in its own library, as `workspace.<name>`. Omit for the deployment\u2019s vocabulary alone.',
      ),
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
          /**
           * Which of this facet's FIELDS takes the id of a registered
           * asset, and of which kind — the join between the two lists
           * below, which each carried one half of it.
           *
           * Without it a model has to guess that `visual.stencil/v0`'s
           * `stencil` field is where a `stencils` id goes. Round 13 of the
           * eval lane measured what that costs: asked for a flow whose
           * kinds differ, a model called this tool with
           * `assetKind: 'stencils'`, then wrote `visual.shape/v0` with
           * `{kind: 'diamond'}` — a registered facet, a successful write,
           * and a SILHOUETTE rather than a kind, so the board recorded a
           * distinction a reader sees and the document does not state. The
           * shape facet publishes an enum containing the word it wanted;
           * the stencil facet publishes a pattern-checked string. It picked
           * the one it could act on.
           *
           * OMITTED, not `{}`, for a facet that names no asset: most do
           * not, and an empty object on every entry is bytes that say
           * nothing.
           */
          assetRefs: z.record(z.string(), assetKindSchema).optional(),
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
    /**
     * What `target` filtered OUT, by the scope that holds it — keys only,
     * since a caller who wants one can ask for that scope.
     *
     * Present only when `target` was given, and omitted rather than `{}`
     * when the filter removed nothing, on the same rule `assetRefs`
     * follows: a key on every answer is bytes that say nothing.
     *
     * Measured, not reasoned (ADR-0031 round 15, 0 of 3). Asked to tell two
     * things apart at once, every trial called this tool with
     * `target: 'node'` — the right question while dressing boxes — and so
     * never saw `visual.axes/v0`, which is canvas-only and is the one facet
     * that records what a colour MEANS. All three coloured by health and
     * recorded nothing. A description saying the filter hides a scope was
     * measured next and moved nothing (round 16: `target: 'node'` x3 again).
     *
     * THIS DID NOT MOVE IT EITHER, and that is the finding rather than a
     * disappointment: round 17 read 0 of 3, `colour contested` three times.
     * Two of the three trials called with `target: 'node'` and so had
     * `otherTargets` naming `visual.axes/v0` in front of them; the third
     * passed `assetKind` alone and never asked. So the structural form this
     * tool's history predicted would work is measured and does not, as a
     * remedy for C14.
     *
     * KEPT anyway, on a ground that is not C14 and is stated plainly so the
     * next reader can overrule it: an answer that silently drops a scope is
     * a partial truth, and this makes it whole for +176 WIRE bytes and ZERO
     * model-visible ones — a table's price is its INPUT schema, and this is
     * output. What is withdrawn is the CLAIM, not the field.
     *
     * `partialRecord`, not `record`: handed an enum key, zod 4 makes EVERY
     * member required, so an answer naming only the scopes that actually
     * hold something fails its own output contract. Caught by three guards
     * at once — `tsc`, the input fuzz property, and `smoke:e2e`'s runtime
     * validation of `structuredContent` — which is what the first draft of
     * this field did.
     */
    otherTargets: z.partialRecord(facetTargetSchema, z.array(z.string())).optional(),
    /**
     * The tags the workspace already uses, counted by what carries them
     * (ADR-0040 decision 5). Present only with a `workspaceId`: a deployment
     * has a vocabulary and no usage, and a caller asking what is registered
     * must not pay for a workspace it never named.
     */
    tags: z.array(tagInUseSchema).optional(),
  })
  .strict()
export type FacetListOutput = z.infer<typeof facetListOutputSchema>

export function createFacetListTool(deps: ServerDeps) {
  return {
    name: 'wb_facet_list' as const,
    description:
      'List what a write may name: facets (the exact key to write, the owning plugin, which objects each may be attached to, the payload schema) and assets (the stencil, theme and icon ids a write names by id). This deployment\u2019s, plus — when workspaceId is given — the stencils the workspace defines in its own library and the tags it already uses, counted by what carries them. Optionally filtered to one target or one asset kind.',
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
      // A workspace nobody made REFUSES here, unlike on the write paths:
      // `workspaceId` is the only thing this caller named, so there is no
      // more specific refusal to make room for, and answering the
      // deployment's own stencils would read as "this workspace defines
      // none" — a wrong answer wearing the shape of a right one.
      // ONE listing serves both the library and the tags in use.
      const listed =
        parsed.workspaceId === undefined
          ? undefined
          : await listWorkspaceDocuments(deps, parsed.workspaceId, 'refuse')
      const registry =
        parsed.workspaceId === undefined
          ? (deps.facetRegistry ?? bundledFacetRegistry)
          : await workspaceFacetRegistry(deps, parsed.workspaceId, 'refuse', listed)
      const allFacets = registry.plugins
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
            // Spread so the key is ABSENT rather than `undefined` for a
            // facet with no asset behind it — `.strict()` admits it either
            // way, but `JSON.stringify` drops an undefined value's key and
            // keeps an explicit `{}`, and the two answers would differ on
            // the wire for no reason.
            ...(definition.assetRefs === undefined
              ? {}
              : { assetRefs: { ...definition.assetRefs } }),
          })),
        )
        // Sorted by key so two calls agree and a diff of the output is
        // stable; registration order is an implementation detail.
        .sort((a, b) => (a.key < b.key ? -1 : 1))
      const facets = allFacets.filter(
        (facet) => parsed.target === undefined || facet.targets.includes(parsed.target),
      )

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
      const tags =
        parsed.workspaceId === undefined || listed === undefined
          ? {}
          : { tags: await computeTagsInUse(deps, parsed.workspaceId, listed) }
      return { facets, assets, ...otherTargets(allFacets, parsed.target), ...tags }
    },
  }
}

/**
 * The scopes the filter removed a facet from, keyed by scope. A facet the
 * filter KEPT never appears here even when it also attaches elsewhere:
 * the answer already named it, and repeating it under its other scopes
 * would bury the entries that are actually missing.
 */
function otherTargets(
  allFacets: readonly { key: string; targets: readonly FacetTarget[] }[],
  target: FacetTarget | undefined,
): { otherTargets?: Partial<Record<FacetTarget, string[]>> } {
  if (target === undefined) return {}
  const byTarget: Partial<Record<FacetTarget, string[]>> = {}
  for (const facet of allFacets) {
    if (facet.targets.includes(target)) continue
    for (const other of facet.targets) {
      byTarget[other] = [...(byTarget[other] ?? []), facet.key]
    }
  }
  return Object.keys(byTarget).length === 0 ? {} : { otherTargets: byTarget }
}

function describeSchema(schema: z.ZodTypeAny): unknown {
  try {
    return z.toJSONSchema(schema)
  } catch {
    return undefined
  }
}
