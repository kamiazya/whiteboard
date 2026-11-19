import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { unplain } from './answers.js'
import type { CrdtEngine } from './types.js'

/** What types an answer: a Zod schema, or any parser that yields `T` from the value. */
export interface AnswerShape<T> {
  parse(value: unknown): T
}

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
 * (or a parser that only asserts the type, where it holds no zod) and says so;
 * one that wants it checked passes a schema.
 */
export async function readValue<T>(
  engine: Pick<CrdtEngine, 'read'>,
  handle: wire.Handle,
  query: wire.Query,
  shape: AnswerShape<T>,
): Promise<T> {
  return unwrapAnswer(await engine.read({ handle, query }), query, shape)
}

/** `readValue` for an answer already in hand, which is what `readNow` gives. */
export function unwrapAnswer<T>(
  response: wire.ReadResponse,
  query: wire.Query,
  shape: AnswerShape<T>,
): T {
  const answer = response.value as { ok: unknown } | { err: string }
  if ('err' in answer) {
    const refusal = new Error(`${query.query} was refused: ${answer.err}`)
    refusal.name = answer.err
    throw refusal
  }
  return shape.parse(unplain(answer.ok))
}
