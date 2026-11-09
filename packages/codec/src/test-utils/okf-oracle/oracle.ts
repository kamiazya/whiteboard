import { parseOkf } from '../../okf/parse.js'
import type { OkfMarkdownDocument } from '../../okf/schema.js'
import { OkfNotYamlSafeError, serializeOkf } from '../../okf/serialize.js'
import {
  decode,
  type Encoded,
  encode,
  isWellFormed,
  toWellFormed,
  readerCase as yamlCase,
} from '../frontmatter-oracle/oracle.js'

/**
 * The TypeScript's answers that the Rust OKF envelope is held to
 * (`crates/core/codec/tests/okf_oracle.rs`).
 *
 * A reader outcome is the parsed document, encoded exactly as the frontmatter
 * oracle encodes a value, or a refusal: the stage, a class the Rust port
 * names too, and for a schema failure each Zod issue's path and code. The
 * message text is not recorded. Rust words its refusals in its own types, so
 * agreement is on the stage, the class and where and why the schema refused.
 */
type YamlClass = 'anchor' | 'depth' | 'subset' | 'syntax'

type Refusal =
  | { stage: 'yaml'; class: YamlClass }
  | { stage: 'frontmatter-schema'; class: 'nofence' | 'reserved' }
  | { stage: 'frontmatter-schema'; class: 'schema'; issues: [(string | number)[], string][] }

/**
 * A text is `t`, plus `lone` when it holds a lone surrogate, which JSON cannot
 * spell and a Rust `&str` cannot hold: each is then `[index, unit]` and `t`
 * has U+FFFD in its place.
 */
type Text = { t: string; lone?: [number, number][] }

export type ReaderCase = { k: 'r' } & Text & ({ ok: Encoded } | { err: Refusal })
export type WriterCase = { k: 'w'; d: Encoded } & ({ y: string } | { err: 'unsafe' })
export type RecordedCase = ReaderCase | WriterCase

/** The same split `parseOkf` makes, spelled again so the YAML class is read off the text itself. */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const isLone = (text: string, i: number): boolean => {
  const unit = text.charCodeAt(i)
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = text.charCodeAt(i + 1)
    return !(next >= 0xdc00 && next <= 0xdfff)
  }
  if (unit < 0xdc00 || unit > 0xdfff) return false
  const before = text.charCodeAt(i - 1)
  return !(before >= 0xd800 && before <= 0xdbff)
}

function textOf(text: string): Text {
  if (isWellFormed(text)) return { t: text }
  const lone: [number, number][] = []
  for (let i = 0; i < text.length; i++) if (isLone(text, i)) lone.push([i, text.charCodeAt(i)])
  return { t: toWellFormed(text), lone }
}

export function textFrom(recorded: Text): string {
  const units = recorded.t.split('')
  for (const [index, unit] of recorded.lone ?? []) units[index] = String.fromCharCode(unit)
  return units.join('')
}

function yamlClassOf(text: string): YamlClass {
  const yaml = FENCE.exec(text)?.[1]
  const read = yaml === undefined ? undefined : yamlCase(yaml)
  if (read === undefined || !('err' in read)) {
    throw new Error(`parseOkf refused the YAML of a text whose YAML the reader accepts: ${text}`)
  }
  return read.err
}

function refusalOf(
  text: string,
  error: { stage: string; message: string; issues: readonly unknown[] },
): Refusal {
  if (error.stage === 'yaml') return { stage: 'yaml', class: yamlClassOf(text) }
  if (error.issues.length > 0) {
    const issues = error.issues as { path: PropertyKey[]; code: string }[]
    return {
      stage: 'frontmatter-schema',
      class: 'schema',
      issues: issues.map((issue) => [
        issue.path.map((step) => (typeof step === 'number' ? step : String(step))),
        issue.code,
      ]),
    }
  }
  if (error.message.startsWith('document does not start')) {
    return { stage: 'frontmatter-schema', class: 'nofence' }
  }
  if (error.message.startsWith('frontmatter holds a key named')) {
    return { stage: 'frontmatter-schema', class: 'reserved' }
  }
  throw new Error(`a refusal the oracle has no class for: ${error.message}`)
}

export function readerCase(text: string): ReaderCase {
  const result = parseOkf(text)
  if (result.ok) return { k: 'r', ...textOf(text), ok: encode(result.value) }
  return { k: 'r', ...textOf(text), err: refusalOf(text, result.error) }
}

export function writerCase(document: OkfMarkdownDocument): WriterCase {
  const d = encode(document)
  try {
    const y = serializeOkf(document)
    // JSON spells a lone surrogate as an escape a Rust reader of the recording refuses.
    if (!isWellFormed(y)) throw new Error('a written document holds a lone surrogate')
    return { k: 'w', d, y }
  } catch (error) {
    if (error instanceof OkfNotYamlSafeError) return { k: 'w', d, err: 'unsafe' }
    throw error
  }
}

export function encodeRecording(cases: readonly RecordedCase[]): string {
  return `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`
}

export function decodeRecording(text: string): RecordedCase[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedCase)
}

/** What the TypeScript answers today for a recorded case's input. */
export function answerAgain(recorded: RecordedCase): RecordedCase {
  if (recorded.k === 'w') return writerCase(decode(recorded.d) as OkfMarkdownDocument)
  return readerCase(textFrom(recorded))
}
