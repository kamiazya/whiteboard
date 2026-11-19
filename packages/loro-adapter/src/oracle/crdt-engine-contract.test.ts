import { readFileSync } from 'node:fs'
import { documentEngine } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { WRITERS } from '../engine/writers.js'
import { SYNC_TEXT_BREACH_CODES } from '../sync-text-limits.js'

/**
 * `contracts/crdt/document-engine.schema.json` is the wire the TypeScript and
 * the Rust CRDT engines both implement. Its op and query vocabularies are
 * enums a person writes into the contract, so each is held here to the thing
 * it names, from both sides: a writer, reader or breach shape that exists and
 * is not in the contract fails, and so does a contract entry nothing backs.
 */
const recorded = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

const writeRows = recorded('crdt-write.jsonl') as Array<{ op: string; args: unknown }>
const readRows = recorded('crdt-read.jsonl') as Array<{
  host: 'workspace' | 'document'
  readers: Record<string, unknown>
}>

/** A reader the workspace record answers once per document, keyed `<id>#<suffix>`. */
const PER_DOCUMENT_READERS: Record<string, string> = {
  entry: 'workspaceDocumentEntry',
  projection: 'workspaceDocumentProjection',
}

/** Every reader name the read oracle recorded, per-document ones under their contract name. */
function recordedReaders(): Set<string> {
  const names = new Set<string>()
  for (const { host, readers } of readRows) {
    for (const key of Object.keys(readers)) if (key !== 'perDocument') names.add(key)
    if (host !== 'workspace') continue
    const perDocument = readers.perDocument as Record<string, unknown>
    for (const key of Object.keys(perDocument)) {
      const suffix = key.split('#')[1]
      if (suffix !== undefined) names.add(PER_DOCUMENT_READERS[suffix] ?? `unmapped:${suffix}`)
    }
  }
  return names
}

/**
 * Writers of the write oracle that are not document writes, so the contract
 * does not name them. Every entry needs a reason; a stale one fails.
 */
const NOT_ENGINE_WRITERS: Record<string, string> = {
  minimalChange:
    'pure helper, not a document write; F2 records it for the TS→Rust parity of the helper itself',
}

const sorted = (values: Iterable<string>) => [...values].sort()

describe('the CRDT document-engine contract', () => {
  it('parses every recorded write row as a batch the engine accepts', () => {
    expect(writeRows.length).toBeGreaterThan(100)
    for (const { op, args } of writeRows) {
      if (op in NOT_ENGINE_WRITERS) continue
      const parsed = documentEngine.writeRequestSchema.safeParse({
        handle: 0,
        batch: [{ op, args }],
      })
      expect(parsed.success, `${op}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('names every writer of the write oracle, and nothing else', () => {
    const writers = Object.keys(WRITERS)
    for (const excluded of Object.keys(NOT_ENGINE_WRITERS)) {
      expect(writers, `${excluded} is excluded but is no writer`).toContain(excluded)
      expect(
        documentEngine.writerNameSchema.options,
        `${excluded} is excluded but named`,
      ).not.toContain(excluded)
    }
    expect(sorted(documentEngine.writerNameSchema.options)).toEqual(
      sorted(writers.filter((name) => !(name in NOT_ENGINE_WRITERS))),
    )
  })

  it('records at least one row for every writer the contract names', () => {
    expect(
      sorted(new Set(writeRows.map((row) => row.op).filter((op) => !(op in NOT_ENGINE_WRITERS)))),
    ).toEqual(sorted(documentEngine.writerNameSchema.options))
  })

  it('parses every recorded reader as a query, and names no reader nothing recorded', () => {
    const readers = recordedReaders()
    expect(readers.size).toBeGreaterThan(30)
    for (const query of readers) {
      expect(documentEngine.querySchema.safeParse({ query }).success, query).toBe(true)
    }
    expect(sorted(documentEngine.queryNameSchema.options)).toEqual(sorted(readers))
  })

  it('names every breach shape the sync judges answer, and nothing else', () => {
    expect(sorted(documentEngine.breachShapeSchema.options)).toEqual(
      sorted(Object.keys(SYNC_TEXT_BREACH_CODES)),
    )
  })

  it('refuses a write no writer backs and an unknown key on a call', () => {
    const write = { handle: 0, batch: [{ op: 'noSuchWriter', args: {} }] }
    expect(documentEngine.writeRequestSchema.safeParse(write).success).toBe(false)
    expect(documentEngine.undoRequestSchema.safeParse({ handle: 0, callback: 'x' }).success).toBe(
      false,
    )
  })

  it('answers a mutation with what changed and the update, or with a refusal that changed nothing', () => {
    const results = [
      { outcome: 'applied', changed: ['doc-1'], localUpdate: 'bG9ybw==' },
      { outcome: 'applied', changed: [] },
      { outcome: 'refused', breach: { shape: 'canvas-size', container: 'cid:root-nodes:Map' } },
    ]
    for (const result of results) {
      expect(documentEngine.mutationResultSchema.parse(result)).toEqual(result)
    }
    const refusedWithChanges = {
      outcome: 'refused',
      breach: { shape: 'body' },
      changed: ['doc-1'],
    }
    expect(documentEngine.mutationResultSchema.safeParse(refusedWithChanges).success).toBe(false)
    expect(
      documentEngine.mutationResultSchema.safeParse({
        outcome: 'refused',
        breach: { shape: 'body' },
        localUpdate: 'bG9ybw==',
      }).success,
    ).toBe(false)
    expect(documentEngine.mutationResultSchema.safeParse({ changed: [] }).success).toBe(false)
  })

  it('releases a handle with a close, and refuses a close without one', () => {
    expect(documentEngine.closeRequestSchema.parse({ handle: 3 })).toEqual({ handle: 3 })
    expect(documentEngine.closeRequestSchema.safeParse({}).success).toBe(false)
  })

  it('refuses a splice that starts or removes below zero', () => {
    const splice = { handle: 0, text: 'body', index: 0, remove: 0, insert: '' }
    expect(documentEngine.textSpliceRequestSchema.safeParse(splice).success).toBe(true)
    for (const bad of [{ index: -1 }, { remove: -1 }, { index: 1.5 }]) {
      expect(documentEngine.textSpliceRequestSchema.safeParse({ ...splice, ...bad }).success).toBe(
        false,
      )
    }
  })

  it('asks an export for what its mode needs: a shallow snapshot names its frontiers', () => {
    const frontiers = [{ peer: '1', counter: 4 }]
    const requests = [
      { handle: 0, mode: 'snapshot' },
      { handle: 0, mode: 'update' },
      { handle: 0, mode: 'update', from: frontiers },
      { handle: 0, mode: 'shallow-snapshot', frontiers },
    ]
    for (const request of requests) {
      expect(
        documentEngine.exportRequestSchema.safeParse(request).success,
        JSON.stringify(request),
      ).toBe(true)
    }
    for (const bad of [
      { handle: 0, mode: 'shallow-snapshot' },
      { handle: 0, mode: 'snapshot', frontiers },
      { handle: 0, mode: 'snapshot', from: frontiers },
      { handle: 0, mode: 'update', frontiers },
    ]) {
      expect(documentEngine.exportRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      )
    }
  })
})
