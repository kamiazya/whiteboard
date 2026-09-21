import { z } from 'zod'

/**
 * The ONE shape a daemon HTTP error body may take, as a union of the two
 * families the routes actually emit. Only the second is STRICT: that family
 * is this project's own, so a key outside it is a reason written where no
 * reader looks, while the first is a standard whose extensions belong to it.
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
/**
 * A refusal CODE: lowercase snake_case, and nothing else.
 *
 * The `error` slot is what a client may switch on, so it has to be a stable
 * token rather than a sentence. Written as a schema rather than left to a
 * reader because the two slots are indistinguishable at a call site typing
 * an object literal: `{ error: 'malformed Origin header' }` typechecks,
 * parses, and delivers nothing — `apiErrorReason` finds no `message` and
 * answers `undefined`, so the only description of what went wrong is in the
 * one field no client reads as prose.
 */
export const apiErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)

export const apiErrorBodySchema = z.union([
  // NOT strict, and the asymmetry is the RFC's: 9457 defines `type`,
  // `status`, `detail` and `instance` beside `title`, and explicitly allows
  // extension members. Refusing them would discard the title of a real
  // Problem Details body — measured, `{type, title, status}` from the branch
  // routes stopped reaching `safeErrorCopy` the moment this arm was closed.
  z.object({ title: z.string().min(1) }),
  z
    .object({
      error: apiErrorCodeSchema,
      message: z.string().min(1).optional(),
      /**
       * What to DO about it, for a caller that can act — the viewport routes
       * tell an agent to open the canvas in a browser. Never the reason:
       * `apiErrorReason` answers `message`, so a hint is additional and a
       * body carrying only a hint says nothing.
       */
      hint: z.string().min(1).optional(),
    })
    .strict(),
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

/**
 * The one constructor for a refusal body.
 *
 * Both slots are named, so the code cannot receive a sentence and the reason
 * cannot be left in a field outside the contract. Routes that carried a
 * validation failure as a raw `issues` array flatten it into `message` here:
 * nothing has ever read `issues` — the contract does not admit it, and
 * `apiErrorReason` discards any body carrying it — so it was the reason
 * written where no reader looks.
 */
export function errorBody(code: string, message?: string): ApiErrorBody {
  return message === undefined ? { error: code } : { error: code, message }
}
