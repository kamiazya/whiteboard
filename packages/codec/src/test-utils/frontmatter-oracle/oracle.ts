/**
 * How a frontmatter value is recorded, as the Rust frontmatter reader and
 * writer replay it (`crates/core/codec/tests/recorded_oracle.rs`, over the
 * committed `frontmatter.jsonl`). A value is encoded
 * exactly: a number as the hex of its 64 bits (so `-0` and `NaN` survive), a
 * mapping as its keys in the order JavaScript enumerates them. A string that is
 * not well-formed UTF-16 (a lone surrogate, which JSON cannot spell and a Rust
 * `String` cannot hold) is its code units, `{u: [...]}`.
 */
export type Encoded =
  | null
  | boolean
  | string
  | { u: number[] }
  | { f: string }
  | { big: string }
  | { m: [string | { u: number[] }, Encoded][] }
  | Encoded[]

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export const isWellFormed = (text: string): boolean => !LONE_SURROGATE.test(text)

/** `text` with each lone surrogate replaced by U+FFFD. */
export const toWellFormed = (text: string): string =>
  text.replaceAll(new RegExp(LONE_SURROGATE, 'g'), '\uFFFD')

const view = new DataView(new ArrayBuffer(8))

function encodeText(text: string): string | { u: number[] } {
  return isWellFormed(text)
    ? text
    : { u: Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)) }
}

function decodeText(text: string | { u: number[] }): string {
  return typeof text === 'string' ? text : String.fromCharCode(...text.u)
}

export function encode(value: unknown): Encoded {
  if (typeof value === 'string') return encodeText(value)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    view.setFloat64(0, value)
    return { f: view.getBigUint64(0).toString(16).padStart(16, '0') }
  }
  if (typeof value === 'bigint') return { big: value.toString() }
  if (Array.isArray(value)) return value.map(encode)
  if (typeof value === 'object' && value !== undefined) {
    const record = value as Record<string, unknown>
    return { m: Object.keys(record).map((key) => [encodeText(key), encode(record[key])]) }
  }
  throw new Error(`a frontmatter value cannot be ${typeof value}`)
}

/** The value an `Encoded` stands for, with a mapping's keys in written order. */
export function decode(encoded: Encoded): unknown {
  if (encoded === null || typeof encoded === 'string' || typeof encoded === 'boolean') {
    return encoded
  }
  if (Array.isArray(encoded)) return encoded.map(decode)
  if ('u' in encoded) return decodeText(encoded)
  if ('f' in encoded) {
    view.setBigUint64(0, BigInt(`0x${encoded.f}`))
    return view.getFloat64(0)
  }
  if ('big' in encoded) return BigInt(encoded.big)
  return Object.fromEntries(encoded.m.map(([key, item]) => [decodeText(key), decode(item)]))
}
