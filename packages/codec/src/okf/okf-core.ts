import type { CodecParseResult } from '../errors.js'
import { codecFailure } from '../errors.js'
import type { OkfMarkdownDocument } from './schema.js'

/**
 * The Rust core's OKF calls, as `@kamiazya/whiteboard-core-wasm`'s `Core`
 * answers them. Declared here, structurally, so this package never imports
 * the shim: a realm's composition root holds both and hands one to the other.
 *
 * Either call may throw to DECLINE (the shim's `CoreInputRefused`, for a head
 * past its cap or a document outside `OkfMarkdownDocument`'s type). A decline
 * is answered below, never by a second implementation. `serializeOkf` may
 * instead throw the core's answer for a value with no YAML spelling, an error
 * named `CoreOkfUnwritable` whose `issues` are the places, with their paths and
 * words; that is thrown as `OkfNotYamlSafeError`.
 */
export interface OkfCore {
  parseOkf(text: string): CodecParseResult<OkfMarkdownDocument>
  serializeOkf(doc: OkfMarkdownDocument): string
}

/**
 * The one throw `serializeOkf` makes on purpose: a frontmatter value YAML has
 * no representation for, or a document the core refuses to write. A distinct
 * class so a caller that wants to refuse THAT — a write, while the author
 * still holds the content — can catch it without also catching a defect in the
 * writer, which must stay loud.
 */
export class OkfNotYamlSafeError extends Error {
  constructor(readonly issues: readonly { path: PropertyKey[]; message: string }[]) {
    super(
      `serializeOkf: frontmatter contains a value that is not yaml-safe: ${issues
        .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
    this.name = 'OkfNotYamlSafeError'
  }
}

/**
 * `parseOkf` or `serializeOkf` was called in a realm that never installed the
 * core. There is no other implementation to answer with, so this is a wiring
 * defect of the realm (a root that did not load the artifact before serving),
 * never an input to handle.
 */
class OkfCoreNotInstalled extends Error {
  constructor(fn: 'parseOkf' | 'serializeOkf') {
    super(
      `${fn} was called before this realm installed the Rust core; call installOkfCore with a loaded core first`,
    )
    this.name = 'OkfCoreNotInstalled'
  }
}

/**
 * The core this realm answers the envelope with, or none. Process-global on
 * purpose: `parseOkf` and `serializeOkf` are synchronous exports that every
 * caller reaches by import, with no dependency to thread a core through. A
 * realm (a web page, a layout worker, the daemon, a test process) acquires its
 * wasm instance asynchronously, installs it once, and every later call uses it
 * synchronously.
 */
let installed: OkfCore | undefined

/**
 * Makes `core` answer this realm's `parseOkf` / `serializeOkf`; `undefined`
 * removes it. Answers the core it replaced, so a caller that installs a stand-in
 * for a while can put the real one back.
 */
export function installOkfCore(core: OkfCore | undefined): OkfCore | undefined {
  const previous = installed
  installed = core
  return previous
}

/** Whether this realm has a core to answer with. */
export const okfCoreInstalled = (): boolean => installed !== undefined

const isNamed = (err: unknown, name: string): err is Error =>
  err instanceof Error && err.name === name

/** The typed error a core's unwritable answer stands for, or undefined when `err` is no such answer. */
function unsafeOf(err: unknown): OkfNotYamlSafeError | undefined {
  if (!isNamed(err, 'CoreOkfUnwritable')) return undefined
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

/**
 * Reads an OKF Markdown document through the realm's core. A text the core
 * declines (a head past its cap) is a refusal at the schema stage carrying the
 * core's reason, since the model bounds what a document's frontmatter may hold.
 */
export function parseOkf(text: string): CodecParseResult<OkfMarkdownDocument> {
  if (installed === undefined) throw new OkfCoreNotInstalled('parseOkf')
  try {
    return installed.parseOkf(text)
  } catch (err) {
    if (!isNamed(err, 'CoreInputRefused')) throw err
    return codecFailure(
      'frontmatter-schema',
      `the OKF reader refused this document: ${err.message}`,
    )
  }
}

/**
 * Writes an OKF Markdown document through the realm's core. A value with no
 * YAML spelling, and a document the core declines (outside
 * `OkfMarkdownDocument`'s type, or past its caps), both throw
 * `OkfNotYamlSafeError`: the write is refused while the author still holds it.
 */
export function serializeOkf(doc: OkfMarkdownDocument): string {
  if (installed === undefined) throw new OkfCoreNotInstalled('serializeOkf')
  try {
    return installed.serializeOkf(doc)
  } catch (err) {
    const unsafe = unsafeOf(err)
    if (unsafe !== undefined) throw unsafe
    if (isNamed(err, 'CoreInputRefused')) {
      throw new OkfNotYamlSafeError([
        { path: [], message: `the OKF writer refused this document: ${err.message}` },
      ])
    }
    throw err
  }
}
