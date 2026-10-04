import { type ApiErrorBody, errorBody } from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import type { z } from 'zod'
import { JSON_BODY_LIMIT_BYTES, readTextWithin } from './body-limit.js'

/**
 * Which of the two error families a route answers in (`apiErrorBodySchema`):
 * `{ title }` Problem Details, or `{ error, message }`. A route keeps the
 * family its clients already read; the reader only makes a body that is not
 * JSON answer one way inside each.
 */
type BodyVoice = 'problem' | 'code'

const NOT_JSON_REASON = 'the request body is not valid JSON'

const NOT_JSON: Record<BodyVoice, ApiErrorBody> = {
  problem: { title: NOT_JSON_REASON },
  code: errorBody('invalid_body', NOT_JSON_REASON),
}

export interface ReadJsonBodyOptions {
  voice: BodyVoice
  /** The route's own sentence for JSON that does not fit the schema. */
  refuseShape: (error: z.ZodError) => ApiErrorBody
  /**
   * An EMPTY body reads as `{}` — the schema's defaults — instead of as a
   * refusal. A body that is present is still held to being JSON.
   */
  optional?: boolean
  /**
   * The most the body may carry, answered 413 `payload_too_large` beyond it.
   * Defaults to `JSON_BODY_LIMIT_BYTES`, which is sized for fields, not
   * content: a route that takes a snapshot or stored content names its own.
   */
  maxBytes?: number
}

/**
 * The request body parsed under `schema`, or the 400 that refuses it.
 *
 * Every JSON body a daemon route reads comes through here, so "not JSON"
 * cannot drift into a different answer per route, and the two unreadable
 * kinds stay distinct: a body that is not JSON at all is answered here, one
 * that is JSON of the wrong shape is answered in the route's own words.
 */
export async function readJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
  options: ReadJsonBodyOptions,
): Promise<{ data: z.infer<S> } | { refusal: Response }> {
  const read = await readTextWithin(c, options.maxBytes ?? JSON_BODY_LIMIT_BYTES, 'Request body')
  if ('refusal' in read) return read
  const { text } = read
  let json: unknown = {}
  if (!(options.optional === true && text.length === 0)) {
    try {
      json = JSON.parse(text)
    } catch {
      return { refusal: c.json(NOT_JSON[options.voice], 400) }
    }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) return { refusal: c.json(options.refuseShape(parsed.error), 400) }
  return { data: parsed.data }
}
