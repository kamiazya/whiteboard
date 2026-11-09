import { parseYamlKeepingWrittenIntegers } from '../../okf/frontmatter-yaml.js'
import { OkfNotYamlSafeError, serializeOkf } from '../../okf/serialize.js'

/**
 * The TypeScript's answers that the Rust frontmatter reader and writer are
 * held to (`crates/core/codec/tests/recorded_oracle.rs`). A value is encoded
 * exactly: a number as the hex of its 64 bits (so `-0` and `NaN` survive), a
 * mapping as its keys in the order JavaScript enumerates them.
 */
type Encoded =
  | null
  | boolean
  | string
  | { f: string }
  | { big: string }
  | { m: [string, Encoded][] }
  | Encoded[]

/** The refusal classes, as the TypeScript reader's own wording names them. */
type RefusalClass = 'anchor' | 'depth' | 'subset' | 'syntax'

export type ReaderCase = { k: 'r'; y: string } & ({ ok: Encoded } | { err: RefusalClass })
export type WriterCase = { k: 'w'; v: Encoded } & ({ y: string } | { err: 'unsafe' })
export type RecordedCase = ReaderCase | WriterCase

const view = new DataView(new ArrayBuffer(8))

function encode(value: unknown): Encoded {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    view.setFloat64(0, value)
    return { f: view.getBigUint64(0).toString(16).padStart(16, '0') }
  }
  if (typeof value === 'bigint') return { big: value.toString() }
  if (Array.isArray(value)) return value.map(encode)
  if (typeof value === 'object' && value !== undefined) {
    const record = value as Record<string, unknown>
    return { m: Object.keys(record).map((key) => [key, encode(record[key])]) }
  }
  throw new Error(`a frontmatter value cannot be ${typeof value}`)
}

/** The value an `Encoded` stands for, with a mapping's keys in written order. */
function decode(encoded: Encoded): unknown {
  if (encoded === null || typeof encoded === 'string' || typeof encoded === 'boolean') {
    return encoded
  }
  if (Array.isArray(encoded)) return encoded.map(decode)
  if ('f' in encoded) {
    view.setBigUint64(0, BigInt(`0x${encoded.f}`))
    return view.getFloat64(0)
  }
  if ('big' in encoded) return BigInt(encoded.big)
  return Object.fromEntries(encoded.m.map(([key, item]) => [key, decode(item)]))
}

function classify(error: unknown): RefusalClass {
  const message = String((error as Error).message)
  if (/anchors and aliases/.test(message)) return 'anchor'
  if (/may nest at most/.test(message)) return 'depth'
  // `yaml`'s own errors carry a code; the subset's refusals do not.
  return (error as { code?: unknown }).code === undefined ? 'subset' : 'syntax'
}

export function readerCase(y: string): ReaderCase {
  try {
    return { k: 'r', y, ok: encode(parseYamlKeepingWrittenIntegers(y)) }
  } catch (error) {
    return { k: 'r', y, err: classify(error) }
  }
}

/** The text `serializeOkf` puts between its fences for this frontmatter. */
export function writtenText(frontmatter: Record<string, unknown>): string {
  const text = serializeOkf({ frontmatter, body: '' } as Parameters<typeof serializeOkf>[0])
  return text.slice('---\n'.length, text.length - '\n---\n'.length)
}

export function writerCase(frontmatter: Record<string, unknown>): WriterCase {
  const v = encode(frontmatter)
  try {
    return { k: 'w', v, y: writtenText(frontmatter) }
  } catch (error) {
    if (error instanceof OkfNotYamlSafeError) return { k: 'w', v, err: 'unsafe' }
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
  if (recorded.k === 'r') return readerCase(recorded.y)
  return writerCase(decode(recorded.v) as Record<string, unknown>)
}
