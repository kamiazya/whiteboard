import { z } from 'zod'

/**
 * The ONE shape a daemon HTTP error body may take, as a union of the two
 * families the routes actually emit.
 *
 * It lives HERE, below every producer, rather than in `daemon-client` where
 * it started. `/api/v1` is served from this package and `daemon-client`
 * depends on it, so a contract filed with the browser CLIENT was out of
 * reach of half the routes it describes — `create-server.ts` answered nine
 * refusals with a raw `issues` array because the constructor was one layer
 * above it. `daemon-client`'s barrel re-exports the reader, the way it already
 * re-exports the `/api/v1` answers from here for exactly this reason.
 *
 * Two schemas over one declaration, because emitting and reading are
 * opposite jobs: `apiErrorBodySchema` is strict in its code family (what a
 * daemon may write) and `apiErrorReadSchema` tolerates what a newer daemon
 * added (what a client may meet).
 *
 * - `{ title }` — RFC 9457-flavoured Problem Details, used by the canvas
 *   CRUD routes. `title` is static, display-intended copy.
 * - `{ error, message? }` — the code+reason family used everywhere else.
 *   `message`, when present beside an `error` code, is daemon-authored
 *   display copy: a route puts the human-readable reason there and nowhere
 *   else.
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

// NOT strict, and the asymmetry is the RFC's: 9457 defines `type`,
// `status`, `detail` and `instance` beside `title`, and explicitly allows
// extension members. Refusing them would discard the title of a real
// Problem Details body — measured, a `{type, title, status}` body
// stopped reaching the UI's error copy the moment this arm was closed.
const problemDetailsArm = z.object({ title: z.string().min(1) })

const codeArmShape = {
  error: apiErrorCodeSchema,
  message: z.string().min(1).optional(),
  /**
   * What to DO about it, for a caller that can act — the viewport routes
   * tell an agent to open the canvas in a browser. Never the reason:
   * `apiErrorReason` answers `message`, so a hint is additional and a
   * body carrying only a hint says nothing.
   */
  hint: z.string().min(1).optional(),
  /**
   * `sole_owner` only (ADR-0051): the workspaces a deletion would leave
   * without an owner. Declared here because the route emits it, so the
   * emission contract admits what is really written; the one reader that
   * shows it is the people screen.
   */
  workspaceIds: z.array(z.string().min(1)).min(1).optional(),
}

/**
 * What a daemon EMITS, which is why the code arm is strict: that family is
 * this project's own, so a key outside it is a reason written where no
 * reader looks. Route tests and the fuzz lanes hold what actually went out
 * against it. A BROWSER does not parse with it — see `apiErrorReadSchema`.
 */
export const apiErrorBodySchema = z.union([problemDetailsArm, z.object(codeArmShape).strict()])

/**
 * What a client READS an error body with. The same two families as
 * `apiErrorBodySchema`, minus the strictness: the hosted app and the daemon
 * update independently, so a newer daemon that adds a field to a refusal
 * (`retryAfter` beside a `rate_limited`) must not make the whole body
 * unreadable to an older bundle — which would drop the very sentence the
 * field travelled with. Zod's default object strips what it does not know.
 */
const apiErrorReadSchema = z.union([problemDetailsArm, z.object(codeArmShape)])

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>

/**
 * The human-readable reason carried by an error body, or `undefined` when
 * the body carries none (a bare `{ error: code }`, or something outside
 * the contract). The single reader every client-side error surface goes
 * through — three hand-rolled readers is how a route's reasons
 * got discarded for months.
 */
export function apiErrorReason(body: unknown): string | undefined {
  const parsed = apiErrorReadSchema.safeParse(body)
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

/**
 * A schema validation failure as this contract's reason.
 *
 * The routes used to answer `{ error: 'invalid input', issues }`, putting the
 * only description of what was wrong in a field the contract does not admit
 * — so `apiErrorReason` discarded the whole body and every caller showed a
 * generic banner. The issues say the same thing in the slot a reader reads.
 */
export function invalidRequestBody(error: z.ZodError): ApiErrorBody {
  return errorBody('invalid_request', error.issues.map(issueText).join('; '))
}

/**
 * One issue as a sentence that names the object it concerns. A nested key
 * the schema does not know says `Unrecognized key: "zzz"` with nothing to say
 * which object it sits in, so the path leads when there is one.
 */
export function issueText(issue: z.ZodError['issues'][number]): string {
  const at = issue.path.join('.')
  return at === '' ? issue.message : `${at}: ${issue.message}`
}
