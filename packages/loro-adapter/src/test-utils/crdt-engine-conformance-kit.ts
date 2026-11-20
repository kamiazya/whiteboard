/**
 * The helpers the CRDT engine conformance cases share: a document an engine's
 * handle holds, as the bytes it exports and npm loro-crdt reads them, and the
 * calls a case makes on an engine, answered as the contract's own types.
 */
import { base64ToBytes, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { exportedBytes } from '../engine/answers.js'
import type { CrdtEngine } from '../engine/types.js'

export const bytesOf = (b64: string): Uint8Array => {
  const bytes = base64ToBytes(b64)
  if (bytes === null) throw new TypeError('not base64')
  return bytes
}
const decode = (b64: string): LoroDoc => {
  const doc = new LoroDoc()
  doc.import(bytesOf(b64))
  return doc
}
// A JSON round trip rather than structuredClone: it drops `undefined` members
// the way the wire does, which structuredClone keeps.
export const jsonOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/**
 * The document an engine's handle holds, as the bytes it exports and npm
 * loro-crdt reads them. An update carries operations only, so a root container
 * a reader merely opened is not in it; a snapshot carries those too.
 */
export function held(
  engine: CrdtEngine,
  handle: number,
  mode: 'snapshot' | 'update' = 'update',
): LoroDoc {
  return decode(exportedBytes(engine.export({ handle, mode })))
}

export async function ask(
  engine: CrdtEngine,
  handle: number,
  query: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const request = wire.readRequestSchema.parse({
    handle,
    query: args === undefined ? { query } : { query, args },
  })
  return jsonOf(wire.readResponseSchema.parse(await engine.read(request)).value)
}

export async function bodyOf(
  engine: CrdtEngine,
  handle: number,
  documentId?: string,
): Promise<string> {
  const answer = (await ask(
    engine,
    handle,
    'markdownBody',
    documentId === undefined ? undefined : { documentId },
  )) as { ok: string }
  return answer.ok
}

/** A journaled engine adds the `seq` it journalled the update under; the wire's own fields are judged. */
export const mutation = (result: object) => {
  const { seq: _journalled, ...wireFields } = result as { seq?: number }
  return wire.mutationResultSchema.parse(wireFields)
}

/** A mutation the test expects the engine to have applied. */
export function applied(result: object): wire.MutationApplied {
  const parsed = mutation(result)
  if (parsed.outcome !== 'applied') {
    throw new Error(`the engine refused the call as ${parsed.breach.shape}`)
  }
  return parsed
}

export function write(
  engine: CrdtEngine,
  handle: number,
  op: string,
  args: unknown,
  judge?: wire.WriteJudge,
) {
  return applied(
    engine.write(
      wire.writeRequestSchema.parse({
        handle,
        batch: [{ op, args }],
        ...(judge === undefined ? {} : { judge }),
      }),
    ),
  )
}

export function splice(
  engine: CrdtEngine,
  handle: number,
  index: number,
  remove: number,
  insert: string,
  documentId?: string,
) {
  return applied(
    engine.textSplice(
      wire.textSpliceRequestSchema.parse({
        handle,
        ...(documentId === undefined ? {} : { documentId }),
        text: 'body',
        runs: [{ index, remove, insert }],
      }),
    ),
  )
}

export const FIRST = '01J00000000000000000000001'
export const SECOND = '01J00000000000000000000002'
export const WORKSPACE_DOCUMENT = { documentId: FIRST, segment: 'note', kind: 'markdown' }

export const openWith = (engine: CrdtEngine, body: string, peer = '1') => {
  const { handle } = engine.open({ peer })
  write(engine, handle, 'writeMarkdownBody', { body })
  return handle
}
