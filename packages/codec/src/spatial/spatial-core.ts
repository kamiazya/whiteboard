import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { ZodError, type ZodIssue } from 'zod'
import type { CodecParseResult } from '../errors.js'
import { parseSpatial as parseSpatialTs } from './parse.js'
import { type SpatialSerializeMode, serializeSpatial as serializeSpatialTs } from './serialize.js'

/**
 * ADR-0054's per-function switch for the JSON Canvas codec: `ts` runs the
 * TypeScript alone; `differential` runs both, reports any difference and
 * answers with the TypeScript; `rust` answers with the core, the TypeScript
 * still present so rollback is flipping this back.
 */
export type SpatialImpl = 'ts' | 'differential' | 'rust'

/**
 * The Rust core's JSON Canvas calls, as `@kamiazya/whiteboard-core-wasm`'s
 * `Core` answers them. Declared here, structurally, so this package never
 * imports the shim: the composition root holds both and hands one to the other.
 *
 * Either call may throw to DECLINE (the shim's `CoreInputRefused` for a text
 * past its cap, a lone surrogate, nesting past its reader, a link whose host
 * needs tables it does not carry). A decline is answered by the TypeScript, in
 * every mode, so a caller sees the TypeScript's own answer and error class.
 * `serializeSpatial` may instead throw the core's answer for a canvas the
 * strict mode refuses: an error named `CoreSpatialInvalid` whose `issues` are
 * the places, with their paths, codes and words. That is no decline: it is
 * thrown as the `ZodError` the TypeScript writer throws.
 */
export interface SpatialCore {
  parseSpatial(text: string): CodecParseResult<SpatialCanvas>
  serializeSpatial(canvas: SpatialCanvas, mode: SpatialSerializeMode): string
}

/**
 * A difference `differential` mode found, or a call the core declined. The
 * two answers are given whole, each as one canonical string, so the report
 * needs nothing else to be read.
 */
export type SpatialMismatch =
  | {
      readonly fn: 'parseSpatial'
      readonly kind: 'differs'
      readonly ts: string
      readonly rust: string
      readonly text: string
    }
  | {
      readonly fn: 'serializeSpatial'
      readonly kind: 'differs'
      readonly ts: string
      readonly rust: string
      readonly canvas: SpatialCanvas
      readonly mode: SpatialSerializeMode
    }
  | {
      readonly fn: 'parseSpatial' | 'serializeSpatial'
      readonly kind: 'declined'
      readonly err: unknown
    }

/** The core as a caller is handed it: the implementation, the switch per function, where a report goes. */
export interface SpatialCodecCore {
  readonly spatial: SpatialCore
  readonly impl: { readonly parseSpatial: SpatialImpl; readonly serializeSpatial: SpatialImpl }
  readonly onMismatch?: (mismatch: SpatialMismatch) => void
}

/** `parseSpatial` and `serializeSpatial` as the switch answers them. */
export interface SpatialCodec {
  parseSpatial(text: string): CodecParseResult<SpatialCanvas>
  serializeSpatial(canvas: SpatialCanvas, mode: SpatialSerializeMode): string
}

const bits = new DataView(new ArrayBuffer(8))

/**
 * A canvas as plain JSON that tells apart everything one can hold: a number by
 * its 64 bits (so `-0` is not `0`), a key holding `undefined` from an absent
 * one, a list from an object, and an object's keys in the order JavaScript
 * enumerates them.
 */
function canonicalValue(value: unknown): unknown {
  if (typeof value === 'number') {
    bits.setFloat64(0, value)
    return ['f', bits.getBigUint64(0).toString(16)]
  }
  if (value === undefined) return ['u']
  if (Array.isArray(value)) return ['s', ...value.map(canonicalValue)]
  if (typeof value === 'object' && value !== null) {
    return ['m', ...Object.entries(value).flatMap(([k, v]) => [k, canonicalValue(v)])]
  }
  return value
}

/**
 * What a schema issue is held equal on: its path and code, and its words only
 * for a refinement the schema states in code (`custom`), since the core names
 * every other issue by its code rather than in Zod's words.
 */
const canonicalIssue = (issue: { path: PropertyKey[]; code: string; message: string }) => [
  issue.path.map(String),
  issue.code,
  issue.code === 'custom' ? issue.message : '',
]

/** What the two readers are held equal on: the canvas whole, or a refusal's stage, message and issues. */
function canonicalParse(result: CodecParseResult<SpatialCanvas>): string {
  if (result.ok) return JSON.stringify(['ok', canonicalValue(result.value)])
  const { stage, message, issues } = result.error
  return JSON.stringify(['err', stage, message, issues.map(canonicalIssue)])
}

type Answer<T> = { readonly value: T } | { readonly threw: unknown }

function ask<T>(call: () => T): Answer<T> {
  try {
    return { value: call() }
  } catch (threw) {
    return { threw }
  }
}

const answered = <T>(answer: Answer<T>): T => {
  if ('threw' in answer) throw answer.threw
  return answer.value
}

/** A writer's answer as one string: the text, the strict mode's refusal, or that it threw something else. */
const canonicalWrite = (answer: Answer<string>): string => {
  if ('value' in answer) return JSON.stringify(['ok', answer.value])
  if (!(answer.threw instanceof ZodError)) return JSON.stringify(['threw'])
  return JSON.stringify(['invalid', answer.threw.issues.map(canonicalIssue)])
}

/** The `ZodError` a core's strict-mode refusal stands for, or undefined when `err` is no such answer. */
function invalidOf(err: unknown): ZodError | undefined {
  if (!(err instanceof Error) || err.name !== 'CoreSpatialInvalid') return undefined
  const issues: unknown = (err as { issues?: unknown }).issues
  const isStep = (step: unknown) => typeof step === 'string' || typeof step === 'number'
  const isIssue = (issue: unknown): issue is ZodIssue => {
    const { path, code, message } = (issue ?? {}) as Record<string, unknown>
    return (
      Array.isArray(path) &&
      path.every(isStep) &&
      typeof code === 'string' &&
      typeof message === 'string'
    )
  }
  return Array.isArray(issues) && issues.every(isIssue)
    ? new ZodError(issues.map((issue) => ({ ...issue })))
    : undefined
}

function parseWith(core: SpatialCodecCore, text: string): CodecParseResult<SpatialCanvas> {
  const impl = core.impl.parseSpatial
  if (impl === 'ts') return parseSpatialTs(text)
  const rust = ask(() => core.spatial.parseSpatial(text))
  if ('threw' in rust) {
    core.onMismatch?.({ fn: 'parseSpatial', kind: 'declined', err: rust.threw })
    return parseSpatialTs(text)
  }
  if (impl === 'rust') return rust.value
  const ts = parseSpatialTs(text)
  const [tsValue, rustValue] = [canonicalParse(ts), canonicalParse(rust.value)]
  if (tsValue !== rustValue) {
    core.onMismatch?.({ fn: 'parseSpatial', kind: 'differs', ts: tsValue, rust: rustValue, text })
  }
  return ts
}

function serializeWith(
  core: SpatialCodecCore,
  canvas: SpatialCanvas,
  mode: SpatialSerializeMode,
): string {
  const impl = core.impl.serializeSpatial
  if (impl === 'ts') return serializeSpatialTs(canvas, mode)
  const asked = ask(() => core.spatial.serializeSpatial(canvas, mode))
  const invalid = 'threw' in asked ? invalidOf(asked.threw) : undefined
  const rust: Answer<string> = invalid === undefined ? asked : { threw: invalid }
  if ('threw' in rust && invalid === undefined) {
    core.onMismatch?.({ fn: 'serializeSpatial', kind: 'declined', err: rust.threw })
    return serializeSpatialTs(canvas, mode)
  }
  if (impl === 'rust') return answered(rust)
  const ts = ask(() => serializeSpatialTs(canvas, mode))
  const [tsValue, rustValue] = [canonicalWrite(ts), canonicalWrite(rust)]
  if (tsValue !== rustValue) {
    core.onMismatch?.({
      fn: 'serializeSpatial',
      kind: 'differs',
      ts: tsValue,
      rust: rustValue,
      canvas,
      mode,
    })
  }
  return answered(ts)
}

/**
 * The JSON Canvas codec as `core` says to answer it: by the TypeScript when no
 * core is given or its switch reads `ts`, by the core under `rust`, and under
 * `differential` by the TypeScript with the core run beside it. A core that
 * throws has declined, and the TypeScript answers in either mode.
 */
export function spatialCodec(core: SpatialCodecCore | undefined): SpatialCodec {
  if (core === undefined) {
    return { parseSpatial: parseSpatialTs, serializeSpatial: serializeSpatialTs }
  }
  return {
    parseSpatial: (text) => parseWith(core, text),
    serializeSpatial: (canvas, mode) => serializeWith(core, canvas, mode),
  }
}
