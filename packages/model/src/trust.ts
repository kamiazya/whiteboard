import { z } from 'zod'

/**
 * OKF v0.2's trust family (SPEC §5.2): `generated` records how the current
 * content was produced, `verified` records who or what has confirmed it.
 * They are deliberately independent — content can change without being
 * re-confirmed, and a fact can be re-confirmed without being regenerated.
 *
 * These are ROOT frontmatter keys OKF itself defines, not extension facets
 * (ADR-0013's `{namespace}.{name}/v{n}` bucket) and not core facets: they
 * carry their own storage bucket precisely so a client rewriting its own
 * tags cannot delete a stamp it never wrote. See ADR-0016.
 */

/**
 * OKF §7's actor convention: `<producer>/<version>` for an agent or tool,
 * `human:<id>` for a person, `process:<id>` for an automated process.
 *
 * Validated only as a non-blank single-line string, NOT against those three
 * shapes, because the list is not exhaustive and the spec itself steps
 * outside it — §5.1's own example writes `author: team:ga4-docs`. A schema
 * that enforced the three bullets would reject the specification's own
 * sample data.
 *
 * The one shape that carries meaning is the `human:` prefix, which §5.3
 * makes load-bearing for trust tiers. `isHumanActor` is the single place
 * that check lives.
 */
export const okfActorSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && !/[\r\n]/.test(value), {
    message: 'an OKF actor is a single-line string with no surrounding whitespace',
  })

/**
 * §5: "Every timestamp-valued key in OKF is an ISO 8601 datetime with an
 * explicit UTC offset." Stored in the `Z` form this codebase emits, and
 * accepted in any explicit-offset form so a document written elsewhere is
 * not rejected for choosing `+00:00`.
 */
export const okfTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    'an OKF timestamp is an ISO 8601 datetime with an explicit UTC offset',
  )

/**
 * `by` and `at` are required; anything else a producer wrote is KEPT.
 *
 * Loose rather than strict because §4.1 asks a consumer to preserve unknown
 * frontmatter keys, and a strict object does the opposite at the worst
 * moment: it rejects, and `parseOkf` then fails the WHOLE document rather
 * than the one key — so a valid v0.2 file from another producer does not
 * open at all. Dropping would be bad; refusing to read is worse.
 *
 * That the family grows is not speculation. `sources` already carries
 * `usage_count` and `last_modified` purely as credibility signals, and §5.1's
 * own example writes an actor form outside §7's three bullets — which is why
 * `okfActorSchema` above is validated loosely. The same reasoning applies to
 * the shape around the actor, and had not been carried across.
 *
 * The family's own root (`trustFacetsSchema`) stays strict: that one is this
 * codebase's storage bucket rather than a frontmatter surface, so a stray key
 * there means a caller wrote to the wrong bucket, not that a producer knew
 * something extra.
 */
export const okfTrustEventSchema = z.object({ by: okfActorSchema, at: okfTimestampSchema }).loose()
export type OkfTrustEvent = z.infer<typeof okfTrustEventSchema>

/**
 * `verified` is a LIST of independent checks — a human sign-off plus a
 * nightly process, say — and "how recently" is the latest `at` (§5.2). A
 * single verifier MAY be written as a bare mapping, which §5.2 makes a MUST
 * for consumers to accept.
 *
 * That widening is a plain function rather than a `z.union(...).transform()`
 * on the stored/published shape, and deliberately so: a schema carrying a
 * transform cannot be represented in JSON Schema, and this one reaches
 * `wb_document_get`'s `outputSchema` — the MCP SDK converts it for
 * `tools/list` and fails the whole listing with "Transforms cannot be
 * represented in JSON Schema". So the reader normalises on the way IN and
 * every schema downstream states the one shape it holds: a list.
 */
export function normalizeOkfVerified(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return [value]
}

export const trustFacetsSchema = z
  .object({
    generated: okfTrustEventSchema.optional(),
    verified: z.array(okfTrustEventSchema).optional(),
  })
  .strict()
export type TrustFacets = z.infer<typeof trustFacetsSchema>

/** §5.3 keys trust tiers off this prefix, so it is a real discriminator. */
export function isHumanActor(actor: string): boolean {
  return actor.startsWith('human:')
}

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/**
 * §5.3, lowest to highest: no `verified` is unverified, `verified` by
 * non-`human:` actors only is machine-confirmed, and any `human:` actor
 * makes it human-reviewed.
 *
 * DERIVED on read, never stored. OKF's whole position on trust is that a
 * stored verdict is subjective, unportable between consumers, and goes
 * stale, so it records the signals and leaves the judgement to the reader
 * (§5.1). A `trustTier` field in the frontmatter would be exactly the
 * stored verdict the spec declines to have.
 */
export function trustTier(trust: TrustFacets | undefined): TrustTier {
  const verified = trust?.verified
  if (verified === undefined || verified.length === 0) return 'unverified'
  return verified.some((event) => isHumanActor(event.by)) ? 'human-reviewed' : 'machine-confirmed'
}
