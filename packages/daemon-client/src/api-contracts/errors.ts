import { z } from 'zod'

/**
 * The ONE shape a daemon HTTP error body may take, as a union of the two
 * families the routes actually emit:
 *
 * - `{ title }` — RFC 9457-flavoured Problem Details, used by the canvas
 *   CRUD routes. `title` is static, display-intended copy.
 * - `{ error, message? }` — the code+reason family used everywhere else
 *   (branches, pairing, runtime, validation). `message`, when present
 *   beside an `error` code, is daemon-authored display copy: the branch
 *   routes put the human-readable reason ("A variation named X already
 *   exists") there and nowhere else.
 *
 * Each arm REQUIRES its discriminating field, so an out-of-contract body
 * fails to parse instead of vacuously succeeding — the previous
 * title-optional schema accepted every object and silently discarded the
 * reason of any body that spelled it differently.
 */
export const apiErrorBodySchema = z.union([
  z.object({ title: z.string().min(1) }),
  z.object({ error: z.string().min(1), message: z.string().min(1).optional() }),
])

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>

/**
 * The human-readable reason carried by an error body, or `undefined` when
 * the body carries none (a bare `{ error: code }`, or something outside
 * the contract). The single reader every client-side error surface goes
 * through — three hand-rolled readers is how the branch routes' reasons
 * got discarded for months.
 */
export function apiErrorReason(body: unknown): string | undefined {
  const parsed = apiErrorBodySchema.safeParse(body)
  if (!parsed.success) return undefined
  if ('title' in parsed.data) return parsed.data.title
  return parsed.data.message
}
