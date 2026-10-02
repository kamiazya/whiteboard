import { z } from 'zod'

// Wire contract for `whiteboard search fetch-model --json`. Declared here, in
// `shared/`, rather than beside the other operator outputs in
// `cli/operator-json.ts`, because the packed-tarball smoke reads the command's
// stdout through it and a smoke is not allowed to import the CLI. `schemaVersion`
// is `OPERATOR_JSON_SCHEMA_VERSION`'s value, pinned by the type the command
// stamps it with.

const searchFetchModelTarget = {
  schemaVersion: z.literal(1),
  cacheDir: z.string(),
  model: z.string(),
  dtype: z.enum(['q8', 'fp32']),
}

export const searchFetchModelOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...searchFetchModelTarget,
      kind: z.literal('ok'),
      ok: z.literal(true),
      dimensions: z.number().int(),
      elapsedMs: z.number(),
    })
    .strict(),
  z
    .object({
      ...searchFetchModelTarget,
      kind: z.literal('failed'),
      ok: z.literal(false),
      failure: z.enum([
        'runtime-missing',
        'weights-missing',
        'load-failed',
        'unexpected-dimensions',
      ]),
      remedy: z.string(),
      // The underlying message, redacted, when there is something to say
      // beyond the remedy.
      detail: z.string().optional(),
    })
    .strict(),
])

export type SearchFetchModelOutput = z.infer<typeof searchFetchModelOutputSchema>
