import { type ApiErrorBody, errorBody } from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import type { z } from 'zod'
import { JSON_BODY_LIMIT_BYTES, readTextWithin } from './body-limit.js'

const NOT_JSON: ApiErrorBody = errorBody('invalid_body', 'the request body is not valid JSON')

export interface ReadJsonBodyOptions {
  /** The route's own sentence for JSON that does not fit the schema. */
  refuseShape: (error: z.ZodError) => ApiErrorBody
  /**
   * The status that sentence is answered with; 400 when absent. A schema
   * that bounds how MANY of something a body may carry answers 413 past it,
   * which a caller reads as "send less" rather than "send it differently".
   */
  refuseStatus?: (error: z.ZodError) => 400 | 413
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
      return { refusal: c.json(NOT_JSON, 400) }
    }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const status = options.refuseStatus?.(parsed.error) ?? 400
    return { refusal: c.json(options.refuseShape(parsed.error), status) }
  }
  return { data: parsed.data }
}
