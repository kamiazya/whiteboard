import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  JSON_CANVAS_PARSE_CAPS,
  JSON_CANVAS_SERIALIZE_CAPS,
  type RefusalCode,
} from './generated/input-caps.js'
import { decodeValue, isWellFormed, wireOf } from './value-wire.js'

// JSON Canvas over the wasm artifact (`crates/bindings/wasm/src/json_canvas.rs`).
//
// The result and error types are composed here and not imported from codec,
// for the reason `okf.ts` gives: codec will take this package's implementation
// through its switch, so the dependency points from codec to here. The
// differential in `packages/codec` holds them assignable to codec's own.

/** How `serializeSpatial` writes a canvas: JSON Canvas 1.0 alone, or with `x-whiteboard`. */
export type SpatialMode = 'strict' | 'extended'

/** The Zod issue codes the wire schema raises. */
type SpatialIssueCode =
  | 'invalid_type'
  | 'too_small'
  | 'too_big'
  | 'invalid_format'
  | 'invalid_value'
  | 'invalid_union'
  | 'custom'

/**
 * One place the wire schema refused: where and why. Zod's issue also carries
 * the fields its code defines (`expected`, `minimum`, ...), which the Rust
 * reader does not produce.
 */
export interface SpatialIssue {
  readonly code: SpatialIssueCode
  readonly path: (string | number)[]
  readonly message: string
}

/** `parseSpatial`'s answer: the canvas, or the stage, a message and each issue. */
export type SpatialParseResult =
  | { ok: true; value: SpatialCanvas }
  | {
      ok: false
      error: {
        readonly stage: 'json-syntax' | 'json-canvas-schema'
        readonly message: string
        readonly issues: SpatialIssue[]
      }
    }

/** The errors this module throws, made by the package entry that owns their classes. */
export interface SpatialErrors {
  refused(operation: string, code: RefusalCode, detail?: string): Error
  invalid(issues: readonly SpatialIssue[]): Error
}

/** The glue calls this module makes. */
export interface SpatialGlue {
  json_canvas_parse(text: string): string
  json_canvas_serialize(canvas: string, strict: boolean): string
}

// Worded here and not by the artifact, in the TypeScript's own words. A
// schema issue's message names its code only, as Zod's text for it is not
// reproduced, unless the artifact sends the text of a refinement the schema
// states in code. A syntax error's message is the host's own, asked of
// `JSON.parse` again, which only a refused text reaches.
const CONVERSATION =
  'this file carries x-whiteboard.comments, a conversation an exported file no longer holds: comments live on the document, not in the file. Remove the key to import the content'
const SCHEMA = 'JSON Canvas document failed schema validation'
const ISSUE: Record<SpatialIssueCode, string> = {
  invalid_type: 'Invalid input: wrong type',
  too_small: 'Too small',
  too_big: 'Too big',
  invalid_format: 'Invalid string: wrong format',
  invalid_value: 'Invalid option',
  invalid_union: 'Invalid input',
  custom: 'Invalid input',
}

const isCode = (code: unknown): code is SpatialIssueCode =>
  typeof code === 'string' && Object.hasOwn(ISSUE, code)

function issuesOf(wire: unknown): SpatialIssue[] | undefined {
  if (!Array.isArray(wire)) return undefined
  const issues: SpatialIssue[] = []
  for (const issue of wire as unknown[]) {
    const [path, code, message] = Array.isArray(issue) ? (issue as unknown[]) : []
    if (!Array.isArray(path) || !isCode(code)) return undefined
    if (!path.every((s) => typeof s === 'string' || typeof s === 'number')) return undefined
    // A refinement the schema words itself arrives with its text.
    if (message !== undefined && typeof message !== 'string') return undefined
    issues.push({ code, path: path as (string | number)[], message: message ?? ISSUE[code] })
  }
  return issues
}

const isRefusalCode = (code: unknown): code is RefusalCode =>
  code === 'input-too-large' || code === 'malformed'

/** The error a `["refused", code, class]` answer stands for. */
function refusalOf(errors: SpatialErrors, operation: string, answer: unknown[]): Error {
  const [, code, detail] = answer
  if (!isRefusalCode(code)) return errors.refused(operation, 'malformed', 'answer')
  return errors.refused(operation, code, typeof detail === 'string' ? detail : undefined)
}

/** The message `JSON.parse` gives for `text`, or undefined when it reads it. */
function syntaxMessage(text: string): string | undefined {
  try {
    JSON.parse(text)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

function failure(
  stage: 'json-syntax' | 'json-canvas-schema',
  message: string,
  issues: SpatialIssue[] = [],
): SpatialParseResult {
  return { ok: false, error: { stage, message, issues } }
}

/** A refusal the artifact answered as `["err", stage, class, issues]`, worded here. */
function errorOf(text: string, stage: unknown, cls: unknown, wire: unknown) {
  const issues = issuesOf(wire)
  if (issues === undefined || stage === undefined) return undefined
  if (stage === 'json-syntax' && cls === 'syntax') {
    const message = syntaxMessage(text)
    return message === undefined
      ? undefined
      : failure(stage, `malformed JSON Canvas text: ${message}`)
  }
  if (stage !== 'json-canvas-schema') return undefined
  if (cls === 'conversation') return failure(stage, CONVERSATION)
  return cls === 'schema' ? failure(stage, SCHEMA, issues) : undefined
}

const isRecord = (v: unknown): v is object =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `parseSpatial` over the artifact, or a `CoreInputRefused` the root answers
 * from the TypeScript: for a text past the entry's cap, one holding a lone
 * surrogate (which a Rust `&str` cannot), and whatever the artifact itself
 * declines (nesting past its reader, a link whose host needs tables it does
 * not carry).
 */
export function parseSpatial(
  glue: SpatialGlue,
  errors: SpatialErrors,
  text: string,
): SpatialParseResult {
  if (!isWellFormed(text)) throw errors.refused('json_canvas_parse', 'malformed', 'lone-surrogate')
  // A UTF-16 length is never over its UTF-8 one, so this refuses nothing the
  // artifact would take; the artifact refuses on the bytes.
  if (text.length > JSON_CANVAS_PARSE_CAPS.maxBytes) {
    throw errors.refused('json_canvas_parse', 'input-too-large', 'too-large')
  }
  const answer: unknown = JSON.parse(glue.json_canvas_parse(text))
  const parts = Array.isArray(answer) ? (answer as unknown[]) : []
  const [kind, a, b, c] = parts
  if (kind === 'refused') throw refusalOf(errors, 'json_canvas_parse', parts)
  const canvas = kind === 'ok' ? decodeValue(a, true) : undefined
  if (isRecord(canvas)) return { ok: true, value: canvas as SpatialCanvas }
  const refusal = kind === 'err' ? errorOf(text, a, b, c) : undefined
  if (refusal === undefined) throw errors.refused('json_canvas_parse', 'malformed', 'answer')
  return refusal
}

/**
 * `serializeSpatial` over the artifact. Throws what the strict mode's
 * re-validation throws, as `errors.invalid` over the places, and
 * `CoreInputRefused` for a canvas the wire does not carry (a value `undefined`,
 * a class instance, nesting past what the shim sends), one past the entry's
 * cap, and whatever the artifact declines (a link, a `bigint`), which a root
 * answers from the TypeScript.
 */
export function serializeSpatial(
  glue: SpatialGlue,
  errors: SpatialErrors,
  canvas: SpatialCanvas,
  mode: SpatialMode,
): string {
  const wire = wireOf(canvas, 0, true)
  if (wire === undefined) throw errors.refused('json_canvas_serialize', 'malformed', 'wire')
  const text = JSON.stringify(wire)
  if (text.length > JSON_CANVAS_SERIALIZE_CAPS.maxBytes) {
    throw errors.refused('json_canvas_serialize', 'input-too-large', 'too-large')
  }
  const answer = glue.json_canvas_serialize(text, mode === 'strict')
  // A document opens with `{` and any other answer is a JSON array.
  if (answer.startsWith('{')) return answer
  const parts: unknown = JSON.parse(answer)
  const [kind, issues] = Array.isArray(parts) ? (parts as unknown[]) : []
  const places = kind === 'schema' ? issuesOf(issues) : undefined
  if (places !== undefined && places.length > 0) throw errors.invalid(places)
  throw refusalOf(errors, 'json_canvas_serialize', Array.isArray(parts) ? (parts as unknown[]) : [])
}
