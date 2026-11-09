import type { CoreFacets, ExtensionFacets, FacetsRaw } from '@kamiazya/whiteboard-model'
import { OKF_PARSE_CAPS, OKF_SERIALIZE_CAPS, type RefusalCode } from './generated/input-caps.js'

// The OKF envelope over the wasm artifact (`crates/bindings/wasm/src/okf.rs`).
//
// The envelope types are composed from model's own, and not imported from
// codec: codec will take this package's implementation through its switch, so
// the dependency points from codec to here. The differential in
// `packages/codec` holds them assignable both ways to codec's `z.infer` types.

/** One entry of OKF's trust family (§5.2); anything beyond `by` and `at` is kept. */
export type OkfTrustEvent = { [key: string]: unknown; by: string; at: string }

/** The frontmatter `parseOkf` hands over. */
export type OkfFrontmatter = CoreFacets & {
  generated?: OkfTrustEvent
  verified?: OkfTrustEvent[]
  facets?: ExtensionFacets
  facetsRaw?: FacetsRaw
}

/** An OKF Markdown document: the frontmatter and the body after its fences. */
export interface OkfDocument {
  frontmatter: OkfFrontmatter
  body: string
}

/** Where the frontmatter reader or its schema refused. */
export type OkfParseStage = 'yaml' | 'frontmatter-schema'

/**
 * One place the schema refused: where and why. Zod's issue also carries the
 * fields its code defines (`expected`, `minimum`, ...), which the Rust reader
 * does not produce.
 */
export interface OkfIssue {
  readonly code: 'invalid_type' | 'too_small' | 'invalid_format' | 'custom'
  readonly path: (string | number)[]
  readonly message: string
}

/** `parseOkf`'s answer: the document, or the stage, a message and each issue. */
export type OkfParseResult =
  | { ok: true; value: OkfDocument }
  | {
      ok: false
      error: {
        readonly stage: OkfParseStage
        readonly message: string
        readonly issues: OkfIssue[]
      }
    }

/** The errors this module throws, made by the package entry that owns their classes. */
export interface OkfErrors {
  refused(operation: string, code: RefusalCode): Error
  unwritable(reason: string): Error
}

/** The glue calls this module makes. */
export interface OkfGlue {
  okf_parse(text: string): string
  okf_serialize(frontmatter: string): string
}

// Worded here and not by the artifact. Three are the TypeScript's own words;
// the YAML one cannot be, because the TypeScript's carries the `yaml`
// package's message, which the Rust reader does not have. A schema issue's
// message likewise names its code only.
const NO_FENCE =
  'document does not start with a --- frontmatter block. A minimal OKF document is `---`, a `type:` line, `---`, then the body'
const RESERVED = 'frontmatter holds a key named "__proto__", which no document may hold'
const SCHEMA = 'frontmatter failed OKF schema validation'
const YAML: Record<string, string> = {
  syntax: 'the YAML is malformed',
  anchor: 'anchors and aliases are not supported',
  depth: 'collections are nested too deeply',
  subset: 'the YAML is outside the subset the reader accepts',
}
const ISSUE: Record<OkfIssue['code'], string> = {
  invalid_type: 'Invalid input: wrong type',
  too_small: 'Too small',
  invalid_format: 'Invalid string: wrong format',
  custom: 'Invalid input',
}

// ES2024's `String.prototype.isWellFormed`, typed here so a consumer that
// compiles this source needs no newer `lib`; every runtime that loads the
// artifact has it (Node 20, the evergreen browsers since 2023).
const isWellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed()

const bits = new DataView(new ArrayBuffer(8))

function numberOf(hex: unknown): number | undefined {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/.test(hex)) return undefined
  bits.setBigUint64(0, BigInt(`0x${hex}`))
  return bits.getFloat64(0)
}

const isCode = (code: unknown): code is OkfIssue['code'] =>
  typeof code === 'string' && Object.hasOwn(ISSUE, code)

/** The value a wire stands for (see `okf_wire.rs`), or undefined when it is none. */
function decodeValue(wire: unknown): unknown {
  if (wire === null || typeof wire === 'boolean' || typeof wire === 'string') return wire
  if (!Array.isArray(wire)) return undefined
  const [tag, ...rest] = wire as unknown[]
  if (tag === 'f') return numberOf(rest[0])
  if (tag === 'b') return typeof rest[0] === 'string' ? BigInt(rest[0]) : undefined
  if (tag === 's') return decodeItems(rest)
  return tag === 'm' ? decodeMap(rest) : undefined
}

function decodeItems(wires: unknown[]): unknown[] | undefined {
  const items = wires.map(decodeValue)
  return items.includes(undefined) ? undefined : items
}

function decodeMap(wires: unknown[]): object | undefined {
  if (wires.length % 2 !== 0) return undefined
  const entries: [string, unknown][] = []
  for (let i = 0; i < wires.length; i += 2) {
    const [key, item] = [wires[i], decodeValue(wires[i + 1])]
    if (typeof key !== 'string' || item === undefined) return undefined
    entries.push([key, item])
  }
  return Object.fromEntries(entries)
}

function issuesOf(wire: unknown): OkfIssue[] | undefined {
  if (!Array.isArray(wire)) return undefined
  const issues: OkfIssue[] = []
  for (const issue of wire as unknown[]) {
    const [path, code] = Array.isArray(issue) ? (issue as unknown[]) : []
    const steps = Array.isArray(path) ? (path as unknown[]) : undefined
    if (steps === undefined || !isCode(code)) return undefined
    if (!steps.every((s) => typeof s === 'string' || typeof s === 'number')) return undefined
    issues.push({ code, path: steps as (string | number)[], message: ISSUE[code] })
  }
  return issues
}

function failure(stage: OkfParseStage, message: string, issues: OkfIssue[] = []): OkfParseResult {
  return { ok: false, error: { stage, message, issues } }
}

/** A refusal the artifact answered as `["err", stage, class, issues]`, worded here. */
function refusalOf(stage: unknown, cls: unknown, wire: unknown): OkfParseResult | undefined {
  const issues = issuesOf(wire)
  if (issues === undefined) return undefined
  if (stage === 'yaml' && typeof cls === 'string' && cls in YAML) {
    return failure('yaml', `malformed YAML frontmatter: ${YAML[cls]}`)
  }
  if (stage !== 'frontmatter-schema') return undefined
  if (cls === 'nofence') return failure(stage, NO_FENCE)
  if (cls === 'reserved') return failure(stage, RESERVED)
  return cls === 'schema' ? failure(stage, SCHEMA, issues) : undefined
}

/** `parseOkf` over the artifact, or a `CoreInputRefused` the root answers from the TypeScript. */
export function parseOkf(glue: OkfGlue, errors: OkfErrors, text: string): OkfParseResult {
  // A lone surrogate would cross as U+FFFD, and Rust would then accept a
  // frontmatter the TypeScript refuses. Checked on the whole text, which
  // also covers a body holding one, so that the TypeScript answers it.
  if (!isWellFormed(text)) throw errors.refused('okf_parse', 'malformed')
  // A UTF-16 length is never over its UTF-8 one, so this refuses nothing the
  // artifact would take; the artifact refuses on the bytes.
  if (text.length > OKF_PARSE_CAPS.maxBytes) {
    throw errors.refused('okf_parse', 'input-too-large')
  }
  const answer: unknown = JSON.parse(glue.okf_parse(text))
  const [kind, a, b, c] = Array.isArray(answer) ? (answer as unknown[]) : []
  if (kind === 'refused' && (a === 'input-too-large' || a === 'malformed')) {
    throw errors.refused('okf_parse', a)
  }
  const isRecord = (v: unknown): v is object =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  const frontmatter = kind === 'ok' ? decodeValue(b) : undefined
  if (typeof a === 'number' && Number.isInteger(a) && a <= text.length && isRecord(frontmatter)) {
    return { ok: true, value: { frontmatter: frontmatter as OkfFrontmatter, body: text.slice(a) } }
  }
  const refusal = kind === 'err' ? refusalOf(a, b, c) : undefined
  if (refusal === undefined) throw errors.refused('okf_parse', 'malformed')
  return refusal
}

/** Deeper than any document the writer takes (`maxDepth`), and short of a stack overflow. */
const WIRE_DEPTH = 100

const hex = (n: number): string => {
  bits.setFloat64(0, n)
  return bits.getBigUint64(0).toString(16).padStart(16, '0')
}

/**
 * The wire of a frontmatter value (see `okf_wire.rs`), or undefined when it
 * is not one a document holds: an `undefined`, a function, a symbol, a class
 * instance, a string with a lone surrogate, a cycle or a sparse list. The
 * TypeScript refuses each of those too, with its own error.
 */
function wireOf(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return isWellFormed(value) ? value : undefined
  if (typeof value === 'number') return ['f', hex(value)]
  if (typeof value === 'bigint') return ['b', value.toString()]
  if (typeof value !== 'object' || depth > WIRE_DEPTH) return undefined
  return Array.isArray(value) ? wireOfList(value, depth) : wireOfRecord(value, depth)
}

function wireOfList(list: unknown[], depth: number): unknown[] | undefined {
  const out: unknown[] = ['s']
  for (let i = 0; i < list.length; i++) {
    const item = i in list ? wireOf(list[i], depth + 1) : undefined
    if (item === undefined) return undefined
    out.push(item)
  }
  return out
}

function wireOfRecord(record: object, depth: number): unknown[] | undefined {
  const proto = Object.getPrototypeOf(record)
  if (proto !== Object.prototype && proto !== null) return undefined
  const out: unknown[] = ['m']
  for (const [key, item] of Object.entries(record)) {
    const wire = isWellFormed(key) ? wireOf(item, depth + 1) : undefined
    if (wire === undefined) return undefined
    out.push(key, wire)
  }
  return out
}

/**
 * `serializeOkf` over the artifact. The body never crosses: it is appended to
 * what the artifact wrote before it. Throws `CoreOkfUnwritable` for a value
 * with no YAML spelling and `CoreInputRefused` for a document the wire does not
 * carry, among them a frontmatter whose keys are not in the schema's order
 * (the artifact writes in the order `parseOkf` hands the keys over in).
 */
export function serializeOkf(glue: OkfGlue, errors: OkfErrors, doc: OkfDocument): string {
  const wire = wireOf(doc.frontmatter, 0)
  if (wire === undefined) throw errors.refused('okf_serialize', 'malformed')
  const text = JSON.stringify(wire)
  if (text.length > OKF_SERIALIZE_CAPS.maxBytes) {
    throw errors.refused('okf_serialize', 'input-too-large')
  }
  const answer: unknown = JSON.parse(glue.okf_serialize(text))
  const [kind, a] = Array.isArray(answer) ? (answer as unknown[]) : []
  if (kind === 'ok' && typeof a === 'string') return a + doc.body
  if (kind === 'unwritable' && typeof a === 'string') throw errors.unwritable(a)
  if (kind === 'refused' && (a === 'input-too-large' || a === 'malformed')) {
    throw errors.refused('okf_serialize', a)
  }
  throw errors.refused('okf_serialize', 'malformed')
}
