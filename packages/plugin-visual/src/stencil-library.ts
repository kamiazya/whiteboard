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
import { type StencilAssetInput, stencilAssetSchema } from '@kamiazya/whiteboard-facet-engine'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const VISUAL_STENCILS_KEY = 'visual.stencils/v0'

/**
 * A bare asset name, the same grammar the registry composes ids from. Spelt
 * here rather than imported because this is a SCHEMA: the message a library
 * author sees when they name a stencil "My Bucket" is worth as much as the
 * check.
 */
const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

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
  stencils: z.record(
    z.string().regex(SEGMENT_PATTERN, 'a stencil name must be a lowercase segment, like "bucket"'),
    stencilAssetSchema,
  ),
})

export type VisualStencilsFacet = z.infer<typeof visualStencilsFacetSchema>

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
 * payload the schema refuses, because a malformed library must not stop a
 * drawing being read — the write path is where a bad library is rejected,
 * loudly, with the author present.
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
  const parsed = visualStencilsFacetSchema.safeParse(raw)
  if (!parsed.success) return {}
  return Object.fromEntries(
    Object.entries(parsed.data.stencils).sort(([left], [right]) => (left < right ? -1 : 1)),
  )
}
