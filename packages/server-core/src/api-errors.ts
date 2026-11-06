import { z } from 'zod'

// The ONE shape a daemon HTTP error body may take: `{ error, message?, hint? }`,
// a snake_case code a client switches on beside daemon-authored display copy.
//
// It lives HERE, below every producer, rather than in `daemon-client` where
// it started. `/api/v1` is served from this package and `daemon-client`
// depends on it, so a contract filed with the browser CLIENT was out of
// reach of half the routes it describes. `daemon-client`'s barrel re-exports
// the reader, the way it already re-exports the `/api/v1` answers from here.
//
// Two schemas over one declaration, because emitting and reading are
// opposite jobs: `apiErrorBodySchema` is strict (what a daemon may write)
// and `apiErrorReadSchema` tolerates what a newer daemon added (what a
// client may meet). The code is REQUIRED, so an out-of-contract body fails
// to parse instead of vacuously succeeding and discarding its reason.
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
const apiErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)

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
  /**
   * `promote_too_many_carried` past the version-judging budget only: the
   * budget, in `stateSize` units, so a sender can fit what it carries under it.
   * daemon-client's `promoteJudgedBudgetRefusalSchema` is that refusal's own
   * declaration; this admits the field in the emission contract.
   */
  limit: z.number().int().positive().optional(),
}

/**
 * What a daemon EMITS, which is why the code arm is strict: that family is
 * this project's own, so a key outside it is a reason written where no
 * reader looks. Route tests and the fuzz lanes hold what actually went out
 * against it. A BROWSER does not parse with it — see `apiErrorReadSchema`.
 */
export const apiErrorBodySchema = z.object(codeArmShape).strict()

/**
 * What a client READS an error body with. The same shape as
 * `apiErrorBodySchema`, minus the strictness: the hosted app and the daemon
 * update independently, so a newer daemon that adds a field to a refusal
 * (`retryAfter` beside a `rate_limited`) must not make the whole body
 * unreadable to an older bundle — which would drop the very sentence the
 * field travelled with. Zod's default object strips what it does not know.
 */
const apiErrorReadSchema = z.object(codeArmShape)

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
  return parsed.data.message
}

type CodeChar =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
type CodeLead = Exclude<CodeChar, '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'>

/** Whether `S` continues a code: more code characters, each `_` followed by one. */
type IsCodeTail<S extends string> = S extends ''
  ? true
  : S extends `_${CodeChar}${infer Rest}`
    ? IsCodeTail<Rest>
    : S extends `${CodeChar}${infer Rest}`
      ? IsCodeTail<Rest>
      : false

/**
 * `C` itself when it is a code `apiErrorCodeSchema` admits, `never` when it
 * is a literal it refuses. A code only known as `string` (one a refusal
 * class carries) passes: its own declaration is a literal, and the fuzz
 * lanes parse what actually went out.
 */
export type ApiErrorCode<C extends string> = string extends C
  ? C
  : C extends `${CodeLead}${infer Rest}`
    ? IsCodeTail<Rest> extends true
      ? C
      : never
    : never

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
export function errorBody<const C extends string>(
  code: C & ApiErrorCode<C>,
  message?: string,
): ApiErrorBody {
  return message === undefined ? { error: code } : { error: code, message }
}

/**
 * A schema validation failure as this contract's reason.
 *
 * The issues go in the slot a reader reads. A body of `{ error: 'invalid
 * input', issues }` would put the only description of what was wrong in a
 * field the contract does not admit, so `apiErrorReason` would discard the
 * whole body and every caller would show a generic banner.
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
