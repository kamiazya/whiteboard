import { readFileSync } from 'node:fs'
import { documentEngine } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { SYNC_TEXT_BREACH_CODES } from '../sync-text-limits.js'
import { WRITERS } from '../test-utils/crdt-write-oracle.js'

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

const sorted = (values: Iterable<string>) => [...values].sort()

describe('the CRDT document-engine contract', () => {
  it('parses every recorded write row as a batch the engine accepts', () => {
    expect(writeRows.length).toBeGreaterThan(100)
    for (const { op, args } of writeRows) {
      const parsed = documentEngine.writeRequestSchema.safeParse({
        handle: 0,
        batch: [{ op, args }],
      })
      expect(parsed.success, `${op}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('names every writer of the write oracle, and nothing else', () => {
    expect(sorted(documentEngine.writerNameSchema.options)).toEqual(sorted(Object.keys(WRITERS)))
  })

  it('records at least one row for every writer the contract names', () => {
    expect(sorted(new Set(writeRows.map((row) => row.op)))).toEqual(
      sorted(documentEngine.writerNameSchema.options),
    )
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
    expect(
      documentEngine.undoRequestSchema.safeParse({ handle: 0, callback: 'x' }).success,
    ).toBe(false)
  })

  it('answers a mutation with what changed, the update, and a breach', () => {
    const result = {
      changed: ['doc-1'],
      localUpdate: 'bG9ybw==',
      breach: { shape: 'canvas-size', container: 'cid:root-nodes:Map' },
    }
    expect(documentEngine.mutationResultSchema.parse(result)).toEqual(result)
    expect(documentEngine.mutationResultSchema.safeParse({}).success).toBe(false)
  })
})
