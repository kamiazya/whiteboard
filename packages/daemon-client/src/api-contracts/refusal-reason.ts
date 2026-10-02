import { apiErrorReason } from '@kamiazya/whiteboard-server-core/api-errors'

/**
 * The reason a keeper gave for refusing a request, and the body it was read
 * from, for a caller that already knows the response is not ok.
 *
 * The one place a `Response` becomes a refusal reason: `apiErrorReason` is
 * the single reader of a BODY, and what each client hand-rolled around it —
 * swallow a body that is not JSON, fall back to a sentence of its own — drifted
 * into two different swallow policies. `fallback` is the only per-caller part,
 * because what to say when the keeper said nothing is the caller's wording.
 * `body` is `undefined` when it was not JSON; it is the seam a typed refusal
 * (e.g. `membershipRefusalSchema`) is read back through, by code rather than
 * by matching the sentence.
 */
export async function refusalReasonOf(
  res: Response,
  fallback: string,
): Promise<{ reason: string; body: unknown }> {
  const body: unknown = await res.json().catch(() => undefined)
  return { reason: apiErrorReason(body) ?? fallback, body }
}
