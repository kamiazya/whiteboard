import type { CodecParseResult } from '../errors.js'
import { parseOkf as parseOkfTs } from './parse.js'
import type { OkfMarkdownDocument } from './schema.js'
import { OkfNotYamlSafeError, serializeOkf as serializeOkfTs } from './serialize.js'

/**
 * ADR-0054's per-function switch for the OKF envelope: `ts` runs the
 * TypeScript alone; `differential` runs both, reports any difference and
 * answers with the TypeScript; `rust` answers with the core, the TypeScript
 * still present so rollback is flipping this back.
 */
export type OkfImpl = 'ts' | 'differential' | 'rust'

/**
 * The Rust core's OKF calls, as `@kamiazya/whiteboard-core-wasm`'s `Core`
 * answers them. Declared here, structurally, so this package never imports
 * the shim: the composition root holds both and hands one to the other.
 *
 * Either call may throw to DECLINE (the shim's `CoreInputRefused` for a head
 * past its cap or a document the wire does not carry). A decline is answered by
 * the TypeScript, in every mode, so a caller sees the TypeScript's own answer
 * and error class. `serializeOkf` may instead throw the core's answer for a
 * value with no YAML spelling: an error named `CoreOkfUnwritable` whose
 * `issues` are the places, with their paths and the TypeScript's words. That
 * is no decline: it is thrown as `OkfNotYamlSafeError`, the typed error the
 * TypeScript writer throws.
 */
export interface OkfCore {
  parseOkf(text: string): CodecParseResult<OkfMarkdownDocument>
  serializeOkf(doc: OkfMarkdownDocument): string
}

/**
 * A difference `differential` mode found, or a call the core declined. The
 * two answers are given whole, each as one canonical string, so the report
 * needs nothing else to be read.
 */
export type OkfMismatch =
  | {
      readonly fn: 'parseOkf'
      readonly kind: 'differs'
      readonly ts: string
      readonly rust: string
      readonly text: string
    }
  | {
      readonly fn: 'serializeOkf'
      readonly kind: 'differs'
      readonly ts: string
      readonly rust: string
      readonly doc: OkfMarkdownDocument
    }
  | { readonly fn: 'parseOkf' | 'serializeOkf'; readonly kind: 'declined'; readonly err: unknown }

/** The core as a caller is handed it: the implementation, the switch per function, where a report goes. */
export interface OkfCodecCore {
  readonly okf: OkfCore
  readonly impl: { readonly parseOkf: OkfImpl; readonly serializeOkf: OkfImpl }
  readonly onMismatch?: (mismatch: OkfMismatch) => void
}

/** `parseOkf` and `serializeOkf` as the switch answers them. */
export interface OkfCodec {
  parseOkf(text: string): CodecParseResult<OkfMarkdownDocument>
  serializeOkf(doc: OkfMarkdownDocument): string
}

const bits = new DataView(new ArrayBuffer(8))

/**
 * A frontmatter value as plain JSON that tells apart everything a document
 * can hold: a number by its 64 bits (so `-0` is not `0`), a bigint from a
 * number, a list from a mapping, and a mapping's keys in the order
 * JavaScript enumerates them.
 */
function canonicalValue(value: unknown): unknown {
  if (typeof value === 'number') {
    bits.setFloat64(0, value)
    return ['f', bits.getBigUint64(0).toString(16)]
  }
  if (typeof value === 'bigint') return ['b', value.toString()]
  if (value === undefined) return ['u']
  if (Array.isArray(value)) return ['s', ...value.map(canonicalValue)]
  if (typeof value === 'object' && value !== null) {
    return ['m', ...Object.entries(value).flatMap(([k, v]) => [k, canonicalValue(v)])]
  }
  return value
}

/**
 * QR-21's ledger of what the OKF differential tolerates: one entry per case,
 * with its reason. Every comparison of the two readers asks it rather than
 * restating a case, and the live differential (`wasm.rust.test.ts`) counts
 * each entry's case actually differing, so an entry that stops being needed
 * fails there instead of hiding a regression.
 */
export const OKF_TOLERATED_DIFFERENCES = {
  'yaml-refusal-message':
    "a refusal at stage `yaml` is held equal on its stage and its `malformed YAML frontmatter: ` prefix, not its words: the TypeScript carries the `yaml` package's message (with line and column), and the Rust reader names the class of fault (owner decision q25)",
} as const

/** Whether a refusal's message is outside the comparison, per `OKF_TOLERATED_DIFFERENCES`. */
export const messageTolerated = (stage: string): boolean => stage === 'yaml'

/**
 * What the two readers are held equal on: the document whole, a refusal's
 * stage and each issue's path, code and message, and the refusal's message
 * unless the ledger above tolerates it.
 */
function canonicalParse(result: CodecParseResult<OkfMarkdownDocument>): string {
  if (result.ok) {
    return JSON.stringify(['ok', canonicalValue(result.value.frontmatter), result.value.body])
  }
  const { stage, message, issues } = result.error
  return JSON.stringify([
    'err',
    stage,
    messageTolerated(stage) ? '' : message,
    issues.map((issue) => [issue.path.map(String), issue.code, issue.message]),
  ])
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

/**
 * A writer's answer as one string: the text, the places it refused with the
 * words and order it named them in, or that it threw something else.
 */
const canonicalWrite = (answer: Answer<string>): string => {
  if ('value' in answer) return JSON.stringify(['ok', answer.value])
  if (!(answer.threw instanceof OkfNotYamlSafeError)) return JSON.stringify(['threw'])
  const places = answer.threw.issues.map((issue) => [issue.path.map(String), issue.message])
  return JSON.stringify(['unsafe', places])
}

/** The typed error a core's unwritable answer stands for, or undefined when `err` is no such answer. */
function unsafeOf(err: unknown): OkfNotYamlSafeError | undefined {
  if (!(err instanceof Error) || err.name !== 'CoreOkfUnwritable') return undefined
  const issues: unknown = (err as { issues?: unknown }).issues
  const isStep = (step: unknown) => typeof step === 'string' || typeof step === 'number'
  const isIssue = (issue: unknown): issue is { path: (string | number)[]; message: string } => {
    const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown }
    return Array.isArray(path) && path.every(isStep) && typeof message === 'string'
  }
  return Array.isArray(issues) && issues.every(isIssue)
    ? new OkfNotYamlSafeError(issues)
    : undefined
}

function parseWith(core: OkfCodecCore, text: string): CodecParseResult<OkfMarkdownDocument> {
  const impl = core.impl.parseOkf
  if (impl === 'ts') return parseOkfTs(text)
  const rust = ask(() => core.okf.parseOkf(text))
  if ('threw' in rust) {
    core.onMismatch?.({ fn: 'parseOkf', kind: 'declined', err: rust.threw })
    return parseOkfTs(text)
  }
  if (impl === 'rust') return rust.value
  const ts = parseOkfTs(text)
  const [tsValue, rustValue] = [canonicalParse(ts), canonicalParse(rust.value)]
  if (tsValue !== rustValue) {
    core.onMismatch?.({ fn: 'parseOkf', kind: 'differs', ts: tsValue, rust: rustValue, text })
  }
  return ts
}

function serializeWith(core: OkfCodecCore, doc: OkfMarkdownDocument): string {
  const impl = core.impl.serializeOkf
  if (impl === 'ts') return serializeOkfTs(doc)
  const asked = ask(() => core.okf.serializeOkf(doc))
  const unsafe = 'threw' in asked ? unsafeOf(asked.threw) : undefined
  const rust: Answer<string> = unsafe === undefined ? asked : { threw: unsafe }
  if ('threw' in rust && unsafe === undefined) {
    core.onMismatch?.({ fn: 'serializeOkf', kind: 'declined', err: rust.threw })
    return serializeOkfTs(doc)
  }
  if (impl === 'rust') return answered(rust)
  const ts = ask(() => serializeOkfTs(doc))
  const [tsValue, rustValue] = [canonicalWrite(ts), canonicalWrite(rust)]
  if (tsValue !== rustValue) {
    core.onMismatch?.({ fn: 'serializeOkf', kind: 'differs', ts: tsValue, rust: rustValue, doc })
  }
  return answered(ts)
}

const typescript: OkfCodec = { parseOkf: parseOkfTs, serializeOkf: serializeOkfTs }

/**
 * The core this realm answers the envelope with, or none. Process-global on
 * purpose: `parseOkf` and `serializeOkf` are synchronous exports that every
 * caller reaches by import, with no dependency to thread a core through. A
 * realm (a web page, a layout worker, the daemon, a test process) acquires its
 * wasm instance asynchronously, installs it once, and every later call uses it
 * synchronously (ADR-0054's stage 3 shape).
 */
let installed: OkfCodec | undefined

/**
 * Makes `core` answer this realm's plain `parseOkf` / `serializeOkf` (and an
 * `okfCodec(undefined)`), each as its `impl` switch says; `undefined` returns
 * them to the TypeScript alone.
 */
export function installOkfCore(core: OkfCodecCore | undefined): void {
  installed = core === undefined ? undefined : okfCodec(core)
}

/** The codec of the realm's installed core, else the TypeScript's. */
const realm: OkfCodec = {
  parseOkf: (text) => (installed ?? typescript).parseOkf(text),
  serializeOkf: (doc) => (installed ?? typescript).serializeOkf(doc),
}

/** `parseOkf` as this realm's installed core says to answer it, else the TypeScript. */
export const parseOkf: OkfCodec['parseOkf'] = realm.parseOkf

/** `serializeOkf` as this realm's installed core says to answer it, else the TypeScript. */
export const serializeOkf: OkfCodec['serializeOkf'] = realm.serializeOkf

/**
 * The OKF envelope as `core` says to answer it: by the TypeScript when its
 * switch reads `ts`, by the core under `rust`, and under `differential` by the
 * TypeScript with the core run beside it. A core that throws has declined, and
 * the TypeScript answers in either mode. With no core given, the realm's
 * installed one answers, else the TypeScript.
 */
export function okfCodec(core: OkfCodecCore | undefined): OkfCodec {
  if (core === undefined) return realm
  return {
    parseOkf: (text) => parseWith(core, text),
    serializeOkf: (doc) => serializeWith(core, doc),
  }
}
