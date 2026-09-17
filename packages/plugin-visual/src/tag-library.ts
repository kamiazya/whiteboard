/**
 * `visual.tags/v0` — the facet that makes a DOCUMENT a workspace's TAG
 * library, and the one reader of it
 * ([ADR-0040](../../../docs/contributing/adr/0040-scoped-tags.md) decision 5's
 * declared layer).
 *
 * The in-use layer (what a workspace has already spent) needs no document:
 * it is counted from the tags on things. This is the other layer — what a
 * workspace DECLARES: the keys it means to use, what each is for, whether a
 * thing carries one value under it or several, the values a key admits, and
 * the colour each value is drawn in. It is what turns a key's values into
 * the legend's swatches by intent rather than by observation, and the only
 * place exclusivity per key can be declared (decision 3 refused it as a
 * default because a claim about a key had nowhere to live).
 *
 * The shape is ADR-0034's, made for stencils: content, not configuration. An
 * ordinary OKF markdown document whose body says what the vocabulary is for
 * and whose facet holds the vocabulary itself, written with `wb_facet_set`,
 * syncing, versioning and forking with its workspace like any document.
 * Unlike a stencil library it composes into no registry: a stencil is an
 * ASSET the registry resolves, and nothing in the registry reads a tag, so
 * the library is data handed to its readers — the layout, the write check,
 * the listing — and an asset kind invented for one reader would be
 * machinery.
 */
import {
  type CanvasColor,
  canvasColorSchema,
  type ExtensionFacets,
  TAG_IDENTIFIER_PATTERN,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const VISUAL_TAGS_KEY = 'visual.tags/v0'

/**
 * A key or a value: the scoped-tag grammar's own identifier. Checked here,
 * at the write, because a library declaring `Health` would describe a key
 * decision 1 refuses to write on anything.
 */
const identifierSchema = z
  .string()
  .regex(TAG_IDENTIFIER_PATTERN, 'a key or value must be a lowercase identifier, like "health"')

export const tagValueDeclarationSchema = z
  .object({
    /** The colour a box or an edge carrying this value is drawn in when it has none of its own. */
    color: canvasColorSchema.optional(),
    description: z.string().optional(),
  })
  .strict()

export const tagKeyDeclarationSchema = z
  .object({
    description: z.string().optional(),
    /** One value at a time: a thing carrying two values under this key is refused. */
    exclusive: z.boolean().optional(),
    /**
     * The values this key ADMITS, each with its own declaration. Absent, the
     * key admits any value and declares nothing about them; present, a
     * value outside it is refused where it is written.
     */
    values: z.record(identifierSchema, tagValueDeclarationSchema).optional(),
  })
  .strict()

/**
 * A wrapper object rather than a bare record, for the reason the stencil
 * library is one: ADR-0013 lets an optional field arrive without a version
 * bump, and a bare record has nowhere to put one.
 */
export const visualTagsFacetSchema = z.object({
  keys: z.record(identifierSchema, tagKeyDeclarationSchema),
})

export type TagValueDeclaration = z.infer<typeof tagValueDeclarationSchema>
export type TagKeyDeclaration = z.infer<typeof tagKeyDeclarationSchema>
export type VisualTagsFacet = z.infer<typeof visualTagsFacetSchema>

/** What a workspace declares: keys by name, each key's values by name. */
export type TagLibrary = Readonly<Record<string, TagKeyDeclaration>>

/**
 * The tag library a MARKDOWN document declares, as its readers take it.
 *
 * DEGRADES rather than throws, like `readStencilLibrary`: a document that
 * is not a library is the common case and answers `{}`, and so does one
 * whose payload the schema refuses — a malformed library must not stop a
 * drawing being read, and the write path is where a bad library is
 * refused, loudly, with the author present.
 *
 * BY NAME at both levels, because a record round-trips through the
 * document's CRDT map and comes back in the map's own order — neither what
 * was written nor anything a reader could predict. A name sort is the only
 * order two reads agree on, and the order a legend or a listing shows.
 */
export function readTagLibrary(facets: ExtensionFacets | undefined): TagLibrary {
  const raw = facets?.[VISUAL_TAGS_KEY]
  if (raw === undefined) return {}
  const parsed = visualTagsFacetSchema.safeParse(raw)
  if (!parsed.success) return {}
  return Object.fromEntries(
    Object.entries(parsed.data.keys)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, declaration]) => [
        key,
        declaration.values === undefined
          ? declaration
          : {
              ...declaration,
              values: Object.fromEntries(
                Object.entries(declaration.values).sort(([left], [right]) =>
                  left < right ? -1 : 1,
                ),
              ),
            },
      ]),
  )
}

/**
 * The colour the library declares for ONE tag, or `undefined`: a plain tag,
 * an undeclared key, an undeclared value and a value declared without a
 * colour all answer nothing. The one lookup every reader of colour-by-intent
 * makes, so they cannot disagree about what "declared" means.
 */
export function declaredColourOf(
  library: TagLibrary,
  scoped: { readonly key: string; readonly value: string },
): CanvasColor | undefined {
  return library[scoped.key]?.values?.[scoped.value]?.color
}
