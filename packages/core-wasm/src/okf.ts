import type { CoreFacets, ExtensionFacets, FacetsRaw } from '@kamiazya/whiteboard-model'
import { OKF_PARSE_CAPS, OKF_SERIALIZE_CAPS, type RefusalCode } from './generated/input-caps.js'
import { REASON_MESSAGE, type UnwritableIssue, unsafeIssues } from './okf-unsafe.js'
import { decodeValue, isWellFormed, wireOf } from './value-wire.js'

// The OKF envelope over the wasm artifact (`crates/bindings/wasm/src/okf.rs`).
//
// The envelope types are composed from model's own, and not imported from
// codec: codec will take this package's implementation through its switch, so
// the dependency points from codec to here. The differential in
// `packages/codec` holds them assignable both ways to codec's `z.infer` types.

/** One entry of OKF's trust family (§5.2); anything beyond `by` and `at` is kept. */
type OkfTrustEvent = { [key: string]: unknown; by: string; at: string }

/** The frontmatter `parseOkf` hands over. */
type OkfFrontmatter = CoreFacets & {
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
type OkfParseStage = 'yaml' | 'frontmatter-schema'

/**
 * One place the schema refused: where and why. Zod's issue also carries the
 * fields its code defines (`expected`, `minimum`, ...), which the Rust reader
 * does not produce.
 */
interface OkfIssue {
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
  refused(operation: string, code: RefusalCode, detail?: string): Error
  unwritable(issues: readonly UnwritableIssue[]): Error
}

/** The glue calls this module makes. */
export interface OkfGlue {
  okf_parse(text: string, mark: number): string
  okf_serialize(frontmatter: string): string
}

// Worded here and not by the artifact. The schema-stage refusals and the
// depth refusal are the TypeScript's own words, and the anchor refusal is
// theirs without the `(found ...)` the Rust reader does not report. A syntax
// or subset refusal cannot be: the TypeScript carries the `yaml` package's
// message or names the construct, where the Rust reader names the class of
// fault. A schema issue's message likewise names its code only.
const NO_FENCE =
  'document does not start with a --- frontmatter block. A minimal OKF document is `---`, a `type:` line, `---`, then the body'
const RESERVED = 'frontmatter holds a key named "__proto__", which no document may hold'
const SCHEMA = 'frontmatter failed OKF schema validation'
const YAML: Record<string, string> = {
  syntax: 'the YAML is malformed',
  anchor: 'YAML anchors and aliases are not allowed in OKF frontmatter',
  depth: 'OKF frontmatter may nest at most 32 levels of mappings and lists',
  subset: 'the YAML is outside the subset the reader accepts',
}
const ISSUE: Record<OkfIssue['code'], string> = {
  invalid_type: 'Invalid input: wrong type',
  too_small: 'Too small',
  invalid_format: 'Invalid string: wrong format',
  custom: 'Invalid input',
}

const isCode = (code: unknown): code is OkfIssue['code'] =>
  typeof code === 'string' && Object.hasOwn(ISSUE, code)

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

// A document's head: the opening fence, the frontmatter and the closing fence
// with the line break after it, which is `parseOkf`'s pattern up to the body.
// The artifact reads nothing past it, so the body never crosses.
const HEAD = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * A character to stand where the head holds a lone surrogate, which a Rust
 * `&str` cannot hold: one the head spells nowhere, neither itself nor as an
 * escape (`\uE000`, `\U0000E000`), so that finding it among the frontmatter's
 * strings and keys can only mean a surrogate was there.
 */
function markFor(head: string): number | undefined {
  const lower = head.toLowerCase()
  for (let code = 0xe000; code < 0xe100; code++) {
    if (!head.includes(String.fromCharCode(code)) && !lower.includes(code.toString(16))) {
      return code
    }
  }
  return undefined
}

/**
 * `parseOkf` over the artifact, or a `CoreInputRefused` the root answers from
 * the TypeScript. The artifact is sent the head alone: a lone surrogate in the
 * body, or a body of any size, is not its business, and the body is sliced
 * from the text here. A lone surrogate in the head is marked, and the artifact
 * refuses the frontmatter whose strings or keys reach it, as the TypeScript
 * does (one in a comment is nothing).
 */
export function parseOkf(glue: OkfGlue, errors: OkfErrors, text: string): OkfParseResult {
  // A text that opens no block has no head, and the artifact names it so.
  const head = HEAD.exec(text)?.[0] ?? ''
  // A UTF-16 length is never over its UTF-8 one, so this refuses nothing the
  // artifact would take; the artifact refuses on the bytes.
  if (head.length > OKF_PARSE_CAPS.maxBytes) {
    throw errors.refused('okf_parse', 'input-too-large')
  }
  const mark = isWellFormed(head) ? 0 : markFor(head)
  if (mark === undefined) throw errors.refused('okf_parse', 'malformed')
  const sent = mark === 0 ? head : head.replace(LONE_SURROGATES, String.fromCharCode(mark))
  const answer: unknown = JSON.parse(glue.okf_parse(sent, mark))
  const [kind, a, b, c] = Array.isArray(answer) ? (answer as unknown[]) : []
  if (kind === 'refused' && (a === 'input-too-large' || a === 'malformed')) {
    throw errors.refused('okf_parse', a)
  }
  const isRecord = (v: unknown): v is object =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  const frontmatter = kind === 'ok' ? decodeValue(b) : undefined
  if (a === head.length && head.length > 0 && isRecord(frontmatter)) {
    return {
      ok: true,
      value: { frontmatter: frontmatter as OkfFrontmatter, body: text.slice(head.length) },
    }
  }
  const refusal = kind === 'err' ? refusalOf(a, b, c) : undefined
  if (refusal === undefined) throw errors.refused('okf_parse', 'malformed')
  return refusal
}

/**
 * `serializeOkf` over the artifact. The body never crosses: it is appended to
 * what the artifact wrote before it. Throws `CoreOkfUnwritable` for a value with
 * no YAML spelling, naming each place as the TypeScript does, and
 * `CoreInputRefused` for a document the wire does not carry and the
 * TypeScript would write: a frontmatter that is not the schema's (a key it does
 * not name, a field of another kind), or nested past the writer.
 */
export function serializeOkf(glue: OkfGlue, errors: OkfErrors, doc: OkfDocument): string {
  const wire = wireOf(doc.frontmatter, 0)
  if (wire === undefined) {
    // The artifact cannot see a value the wire does not carry; the places are
    // told by walking the frontmatter. None found means the wire failed for
    // another reason, a nesting past what the shim sends.
    const issues = unsafeIssues(doc.frontmatter)
    throw issues.length > 0
      ? errors.unwritable(issues)
      : errors.refused('okf_serialize', 'malformed')
  }
  const text = JSON.stringify(wire)
  if (text.length > OKF_SERIALIZE_CAPS.maxBytes) {
    throw errors.refused('okf_serialize', 'input-too-large')
  }
  const answer: unknown = JSON.parse(glue.okf_serialize(text))
  const [kind, a] = Array.isArray(answer) ? (answer as unknown[]) : []
  if (kind === 'ok' && typeof a === 'string') return a + doc.body
  if (kind === 'unwritable') throw unwritableOf(errors, a)
  if (kind === 'refused' && a === 'input-too-large') throw errors.refused('okf_serialize', a)
  // Not a frontmatter the schema holds (a field of another kind, a key it does
  // not name). The artifact never reads past that, but the TypeScript still
  // refuses it first when a value in it has no YAML spelling.
  const issues = kind === 'refused' && a === 'malformed' ? unsafeIssues(doc.frontmatter) : []
  throw issues.length > 0 ? errors.unwritable(issues) : errors.refused('okf_serialize', 'malformed')
}

/** The error for the faults an `unwritable` answer lists, `[path, reason]` each. */
function unwritableOf(errors: OkfErrors, wire: unknown): Error {
  const issues: UnwritableIssue[] = []
  for (const fault of Array.isArray(wire) ? (wire as unknown[]) : []) {
    const [path, reason] = Array.isArray(fault) ? (fault as unknown[]) : []
    const steps = Array.isArray(path) ? (path as unknown[]) : undefined
    if (reason === 'too-deep') return errors.refused('okf_serialize', 'input-too-large')
    const message = typeof reason === 'string' ? REASON_MESSAGE[reason] : undefined
    const walked = steps?.every((s) => typeof s === 'string' || typeof s === 'number')
    if (steps === undefined || !walked || message === undefined) {
      return errors.refused('okf_serialize', 'malformed')
    }
    issues.push({ path: steps as (string | number)[], message })
  }
  return issues.length > 0
    ? errors.unwritable(issues)
    : errors.refused('okf_serialize', 'malformed')
}
