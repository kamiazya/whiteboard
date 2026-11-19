import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
import { unplain } from './answers.js'
import type { CrdtEngine } from './types.js'

/**
 * One named read, answered as the value the reader produced.
 *
 * The contract's answer is the recorded oracle's form — `{ ok }` or `{ err:
 * <class> }`, with what JSON drops written as a marker — so a consumer that
 * wants the value unwraps it once, here. A reader's refusal throws an `Error`
 * named for the refusal's class: the class itself does not cross the contract,
 * since the Rust engine refuses the same rows with no JavaScript class.
 *
 * `shape` types the answer. The contract leaves it any-value on purpose, so a
 * caller whose reader is already total over the shape passes `z.custom<T>()`
 * and says so; one that wants it checked passes a schema.
 */
export async function readValue<T>(
  engine: Pick<CrdtEngine, 'read'>,
  handle: wire.Handle,
  query: wire.Query,
  shape: z.ZodType<T>,
): Promise<T> {
  const { value } = await engine.read({ handle, query })
  const answer = value as { ok: unknown } | { err: string }
  if ('err' in answer) {
    const refusal = new Error(`${query.query} was refused: ${answer.err}`)
    refusal.name = answer.err
    throw refusal
  }
  return shape.parse(unplain(answer.ok))
}
