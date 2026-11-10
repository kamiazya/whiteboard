import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { ZodError, type ZodIssue } from 'zod'
import type { CodecParseResult } from '../errors.js'
import { codecFailure } from '../errors.js'

/** How `serializeSpatial` writes a canvas: JSON Canvas 1.0 alone, or with `x-whiteboard`. */
type SpatialSerializeMode = 'strict' | 'extended'

/**
 * The Rust core's JSON Canvas calls, as `@kamiazya/whiteboard-core-wasm`'s
 * `Core` answers them. Declared here, structurally, so this package never
 * imports the shim: a realm's composition root holds both and hands one to the
 * other.
 *
 * Either call may throw to DECLINE (the shim's `CoreInputRefused`: a text past
 * its cap, a lone surrogate, nesting past its reader, a link whose host needs
 * tables it does not carry, a canvas the wire does not carry). A decline is
 * answered below, never by a second implementation. `serializeSpatial` may
 * instead throw the core's answer for a canvas the strict mode refuses: an
 * error named `CoreSpatialInvalid` whose `issues` are the places, with their
 * paths, codes and words. That is no decline: it is thrown as the `ZodError` the
 * strict writer has always thrown.
 */
export interface SpatialCore {
  parseSpatial(text: string): CodecParseResult<SpatialCanvas>
  serializeSpatial(canvas: SpatialCanvas, mode: SpatialSerializeMode): string
}

/**
 * `parseSpatial` or `serializeSpatial` was called in a realm that never
 * installed the core. There is no other implementation to answer with, so this
 * is a wiring defect of the realm, never an input to handle.
 */
class SpatialCoreNotInstalled extends Error {
  constructor(fn: 'parseSpatial' | 'serializeSpatial') {
    super(
      `${fn} was called before this realm installed the Rust core; call installSpatialCore with a loaded core first`,
    )
    this.name = 'SpatialCoreNotInstalled'
  }
}

/**
 * The core this realm answers JSON Canvas with, or none. Process-global for the
 * reason `installOkfCore`'s is: the exports are synchronous and reached by
 * import, so a realm installs the instance it loaded asynchronously once.
 */
let installed: SpatialCore | undefined

/**
 * Makes `core` answer this realm's `parseSpatial` / `serializeSpatial`;
 * `undefined` removes it. Answers the core it replaced.
 */
export function installSpatialCore(core: SpatialCore | undefined): SpatialCore | undefined {
  const previous = installed
  installed = core
  return previous
}

/** Whether this realm has a core to answer with. */
export const spatialCoreInstalled = (): boolean => installed !== undefined

const isNamed = (err: unknown, name: string): err is Error =>
  err instanceof Error && err.name === name

/** The `ZodError` a core's strict-mode refusal stands for, or undefined when `err` is no such answer. */
function invalidOf(err: unknown): ZodError | undefined {
  if (!isNamed(err, 'CoreSpatialInvalid')) return undefined
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

/**
 * Reads JSON Canvas text as a document through the realm's core. A text the
 * core declines is a refusal at the schema stage carrying the core's reason:
 * the model bounds what a document may hold, so what the reader will not carry
 * (a text past 4 MiB, a lone surrogate, nesting past 64, a link whose host
 * needs tables the core lacks) is a document the schema refuses.
 */
export function parseSpatial(text: string): CodecParseResult<SpatialCanvas> {
  if (installed === undefined) throw new SpatialCoreNotInstalled('parseSpatial')
  try {
    return installed.parseSpatial(text)
  } catch (err) {
    if (!isNamed(err, 'CoreInputRefused')) throw err
    return codecFailure(
      'json-canvas-schema',
      `the JSON Canvas reader refused this document: ${err.message}`,
    )
  }
}

/**
 * Writes a document as JSON Canvas through the realm's core. The strict mode's
 * refusal of a canvas that is no JSON Canvas 1.0 document (a link that is not a
 * URL, an edge naming a missing node, a repeated id) is a `ZodError` over the
 * core's places. A canvas the core declines to write (one the wire does not
 * carry, a value `JSON.stringify` would throw on, a link host it lacks tables
 * for, a document past the cap) is a `ZodError` with one issue at the root: the
 * write is refused while the author still holds the canvas.
 */
export function serializeSpatial(canvas: SpatialCanvas, mode: SpatialSerializeMode): string {
  if (installed === undefined) throw new SpatialCoreNotInstalled('serializeSpatial')
  try {
    return installed.serializeSpatial(canvas, mode)
  } catch (err) {
    const invalid = invalidOf(err)
    if (invalid !== undefined) throw invalid
    if (isNamed(err, 'CoreInputRefused')) {
      throw new ZodError([
        {
          code: 'custom',
          path: [],
          message: `the JSON Canvas writer refused this canvas: ${err.message}`,
        },
      ])
    }
    throw err
  }
}
