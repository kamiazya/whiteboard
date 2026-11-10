import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CoreInputRefused, CoreSpatialInvalid } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { ZodError, type ZodIssue } from 'zod'
import type { CodecParseResult } from '../../errors.js'
import { parseSpatial as parseSpatialTs } from '../../spatial/parse.js'
import {
  type SpatialSerializeMode,
  serializeSpatial as serializeSpatialTs,
} from '../../spatial/serialize.js'
import { running } from './typescript-only.js'

/**
 * The JSON Canvas codec as a root will run it under `rust`, over the staged
 * artifact: the core answers, and a call it declines (`CoreInputRefused`) is
 * answered by the TypeScript, each decline recorded with the input that earned
 * it. Layer 1 of QR-21 (`vitest.rust.config.ts`) points codec's own spatial
 * suites here instead of at `parse.ts` and `serialize.ts`, and counts what the
 * core answered so a suite the core never reached cannot read as a pass.
 *
 * The strict writer's refusal is the core's answer too, thrown as the
 * `ZodError` the TypeScript throws, over the places the core names.
 */
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
const core = await loadCore(readFileSync(artifact))

export const answered = { parseSpatial: 0, serializeSpatial: 0 }

/** A call the core declined, with the input that earned it. */
export interface Decline {
  readonly fn: 'parseSpatial' | 'serializeSpatial'
  readonly reason: string
  readonly input: string | SpatialCanvas
}

/** Calls the core declined since the last `declined.length = 0`; the TypeScript answered each. */
export const declined: Decline[] = []

function decline(fn: Decline['fn'], err: unknown, input: Decline['input']): void {
  if (!(err instanceof CoreInputRefused)) throw err
  declined.push({ fn, reason: err.detail ?? err.code, input })
}

export function parseSpatial(text: string): CodecParseResult<SpatialCanvas> {
  try {
    const answer = core.parseSpatial(text)
    answered.parseSpatial++
    return answer
  } catch (err) {
    decline('parseSpatial', err, text)
    return parseSpatialTs(text)
  }
}

export function serializeSpatial(canvas: SpatialCanvas, mode: SpatialSerializeMode): string {
  if (running.typescriptOnly) return serializeSpatialTs(canvas, mode)
  try {
    const text = core.serializeSpatial(canvas, mode)
    answered.serializeSpatial++
    return text
  } catch (err) {
    if (err instanceof CoreSpatialInvalid) {
      answered.serializeSpatial++
      throw new ZodError(err.issues.map((issue) => ({ ...issue })) as unknown as ZodIssue[])
    }
    decline('serializeSpatial', err, canvas)
    return serializeSpatialTs(canvas, mode)
  }
}
