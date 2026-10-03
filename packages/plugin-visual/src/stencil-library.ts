/**
 * `visual.stencils/v0` — the facet that makes a DOCUMENT a workspace's
 * stencil LIBRARY, and the one reader of it.
 *
 * Its own module rather than a section of `data.ts` because it answers a
 * different question from everything there: those facets say how one OBJECT
 * is drawn, and this one says what VOCABULARY a document defines for other
 * documents to draw with. (`data.ts` also crossed the file-size budget the
 * day this arrived, which is the budget doing its job rather than a
 * coincidence.)
 */
import {
  FACET_SEGMENT_PATTERN,
  type StencilAssetInput,
  stencilAssetSchema,
} from '@kamiazya/whiteboard-facet-engine'
import { canvasColorSchema, type ExtensionFacets } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const VISUAL_STENCILS_KEY = 'visual.stencils/v0'

/**
 * Where a workspace keeps its library.
 *
 * A CONVENTION, and a deliberate one rather than a placeholder. The document
 * declares itself by carrying `visual.stencils/v0` — that facet is the
 * definition — but nothing can ask the index *which documents carry a
 * facet*, so finding it otherwise means opening every markdown document in
 * the workspace on every write that names a stencil. One well-known path
 * costs one lookup, and gives "where do I put my stencils" a single answer,
 * which is worth more to a model than flexibility is.
 *
 * The upgrade is named: when an index can answer that question, this becomes
 * the DEFAULT rather than the rule, and a workspace may spread its
 * vocabulary over several documents.
 *
 * Declared beside the reader because BOTH keepers look the document up by it.
 */
export const STENCIL_LIBRARY_PATH = 'stencils'

/**
 * The engine passes a stencil's `color` through uninterpreted, because the
 * colour of a node belongs to the FORMAT (see `stencil.ts`). This is the
 * format's half: the model's own colour schema is the predicate, so a
 * library cannot hold a colour a node could not carry. It narrows the
 * engine's own string rather than adopting the union, because the union's
 * refusal reads only "must be a 6-digit hex color" and hides the presets an
 * author most likely meant.
 */
const stencilColorSchema = stencilAssetSchema.shape.color
  .unwrap()
  .refine((color) => canvasColorSchema.safeParse(color).success, {
    message: 'must be a preset "1" to "6" or a 6-digit hex color like "#ff0000"',
  })

const libraryStencilSchema = stencilAssetSchema.extend({ color: stencilColorSchema.optional() })

const stencilNameSchema = z
  .string()
  .regex(FACET_SEGMENT_PATTERN, 'a stencil name must be a lowercase segment, like "bucket"')

/**
 * `visual.stencils/v0` — the facet that makes a DOCUMENT a workspace's
 * stencil library (ADR-0034 decision 4; the authoring format was settled on
 * 2026-09-11 and this is it).
 *
 * A library is CONTENT, not configuration. It is an ordinary OKF markdown
 * document whose body says what the vocabulary is for and whose facets hold
 * the vocabulary itself — so it is written with `wb_facet_set`, needs no new
 * tool and no new document kind, and syncs, versions and forks with its
 * workspace exactly as every other document does.
 *
 * Keyed by BARE name, because the registry composes `workspace.<name>` when
 * it builds the synthetic plugin. `stencilAssetSchema` is the engine's, so a
 * library stencil is the same shape as a bundled one and gets the same
 * refusals — including the strict rule that keeps position and text out of a
 * vocabulary.
 *
 * A wrapper object rather than a bare record, deliberately: ADR-0013 lets an
 * OPTIONAL field arrive without a version bump, and a bare record has
 * nowhere to put one. A library that later wants to say something about
 * ITSELF — who it is for, what it extends — can, without moving to v1.
 */
export const visualStencilsFacetSchema = z.object({
  stencils: z.record(stencilNameSchema, libraryStencilSchema),
})

/**
 * The stencil library a MARKDOWN document declares, as the registry's own
 * asset shape, ready to hand to `withWorkspaceStencils`.
 *
 * Takes the facets BUCKET for the same reason `resolveDocumentSymbol` does:
 * this package cannot open stored content, and every caller has already
 * parsed the frontmatter it holds.
 *
 * DEGRADES rather than throws. A document that is not a library is the
 * overwhelmingly common case and answers `{}` here; so does one whose
 * outer shape is wrong. A stencil the schema refuses is left out and the
 * rest stay, because a malformed library must not stop a drawing being read
 * — the write path is where a bad library is rejected, loudly, with the
 * author present.
 *
 * BY NAME, because there is no other order to be faithful to. A
 * deployment's assets are answered in registration order — the bundled
 * vocabulary first, then what the deployment added — and that order is
 * meaningful. A library has none that survives: the record goes into a
 * CRDT map and comes back in the map's own order, measured as `ledger`
 * before `lakehouse` for a document authored the other way round, which is
 * neither what was written nor anything a reader could predict. Sorting is
 * what makes two calls agree, which is the same reason `wb_facet_list`
 * sorts its facets.
 */
export function readStencilLibrary(
  facets: ExtensionFacets | undefined,
): Readonly<Record<string, StencilAssetInput>> {
  const raw = facets?.[VISUAL_STENCILS_KEY]
  if (raw === undefined) return {}
  const outer = z.object({ stencils: z.record(z.string(), z.unknown()) }).safeParse(raw)
  if (!outer.success) return {}
  // One stencil at a time: a library is content, and one entry the schema
  // refuses must not take the others with it.
  const valid: [string, StencilAssetInput][] = []
  for (const [name, stencil] of Object.entries(outer.data.stencils)) {
    if (!stencilNameSchema.safeParse(name).success) continue
    const parsed = libraryStencilSchema.safeParse(stencil)
    if (parsed.success) valid.push([name, parsed.data])
  }
  return Object.fromEntries(valid.sort(([left], [right]) => (left < right ? -1 : 1)))
}
