/**
 * How a Zod schema's answer is recorded for the Rust interpreter of the same
 * contract to replay (`crates/core/facet-engine/tests/schema_oracle.rs`,
 * `crates/core/plugin-visual/tests/facet_write_oracle.rs`).
 *
 * A value is encoded exactly: a mapping as its keys in the order JavaScript
 * enumerates them, a number that is not a safe integer (or is `-0`) as the hex
 * of its 64 bits. A refusal is its issues as `[path, code, detail]`, where the
 * detail is what the code carries beyond a message: the keys an object
 * refused, each arm of a union, or why a record's key was refused. The message
 * is not recorded: the Rust interpreter words its refusals in its own types,
 * so the two agree on where and why, in order, and not on the sentence.
 */
import type { z } from 'zod'

export type Encoded =
  | null
  | boolean
  | number
  | string
  | { f: string }
  | { m: [string, Encoded][] }
  | Encoded[]

type EncodedDetail =
  | null
  | { keys: string[] }
  | { arms: EncodedIssue[][] }
  | { key: EncodedIssue[] }
export type EncodedIssue = [(string | number)[], string, EncodedDetail]

export type Answer = { ok: Encoded } | { err: EncodedIssue[] }

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Whether a value holds a string JSON cannot spell and a Rust `String` cannot hold. */
export function hasLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return LONE_SURROGATE.test(value)
  if (Array.isArray(value)) return value.some(hasLoneSurrogate)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, item]) => LONE_SURROGATE.test(key) || hasLoneSurrogate(item),
    )
  }
  return false
}

const view = new DataView(new ArrayBuffer(8))

export function encode(value: unknown): Encoded {
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return value
    view.setFloat64(0, value)
    return { f: view.getBigUint64(0).toString(16).padStart(16, '0') }
  }
  if (Array.isArray(value)) return value.map(encode)
  if (typeof value === 'object' && value !== undefined) {
    const record = value as Record<string, unknown>
    return { m: Object.keys(record).map((key) => [key, encode(record[key])]) }
  }
  throw new Error(`a recorded value cannot be ${typeof value}`)
}

export function decode(encoded: Encoded): unknown {
  if (encoded === null || typeof encoded !== 'object') return encoded
  if (Array.isArray(encoded)) return encoded.map(decode)
  if ('f' in encoded) {
    view.setBigUint64(0, BigInt(`0x${encoded.f}`))
    return view.getFloat64(0)
  }
  return Object.fromEntries(encoded.m.map(([key, item]) => [key, decode(item)]))
}

function detailOf(issue: z.core.$ZodIssue): EncodedDetail {
  if (issue.code === 'unrecognized_keys') return { keys: [...issue.keys] }
  if (issue.code === 'invalid_union') return { arms: issue.errors.map(encodeIssues) }
  if (issue.code === 'invalid_key') return { key: encodeIssues(issue.issues) }
  return null
}

export function encodeIssues(issues: readonly z.core.$ZodIssue[]): EncodedIssue[] {
  return issues.map((issue) => [
    issue.path.map((step) => (typeof step === 'number' ? step : String(step))),
    issue.code,
    detailOf(issue),
  ])
}

/** What a schema makes of an input, as the recording holds it. */
export function answerSchema(schema: z.ZodTypeAny, input: unknown): Answer {
  const result = schema.safeParse(input)
  return result.success ? { ok: encode(result.data) } : { err: encodeIssues(result.error.issues) }
}
