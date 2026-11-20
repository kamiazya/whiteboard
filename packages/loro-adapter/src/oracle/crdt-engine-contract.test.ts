import { readFileSync } from 'node:fs'
import { documentEngine } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { SYNC_TEXT_BREACH_CODES } from '../sync-text-limits.js'
import { ORACLE_WRITERS } from '../test-utils/crdt-write-oracle.js'
import { SYNC_WORKSPACE_BREACH_CODES } from '../workspace-sync-limits.js'

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

/**
 * Readers the contract names that no row records, because each answers what
 * recorded readers already answer, together. The conformance suite holds each
 * to that; recording one would rewrite every row for an answer they imply.
 */
const DERIVED_READERS: Record<string, string> = {
  documentContentWithTags: 'the answers of documentContent and coreFacets, in one read',
  threadMessageCounts:
    'how many messages each thread stores, readable or not, which the commentThreads answer cannot say',
  retiredCommentRows:
    'how many rows the retired plane holds: the annotations read throws exactly when that is above zero',
  containerPlace:
    'which document a container belongs to, from the nodes read and the container itself: its path, and its length when it is text',
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
    const writers = Object.keys(ORACLE_WRITERS)
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
    for (const derived of Object.keys(DERIVED_READERS)) {
      expect(readers.has(derived), `${derived} is derived but recorded`).toBe(false)
    }
    expect(sorted(documentEngine.queryNameSchema.options)).toEqual(
      sorted([...readers, ...Object.keys(DERIVED_READERS)]),
    )
  })

  it('names every breach shape the sync judges answer, and nothing else', () => {
    expect(sorted(documentEngine.breachShapeSchema.options)).toEqual(
      sorted([...Object.keys(SYNC_TEXT_BREACH_CODES), ...Object.keys(SYNC_WORKSPACE_BREACH_CODES)]),
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
      {
        outcome: 'refused',
        breach: {
          shape: 'too-many-documents',
          detail: { shape: 'too-many-documents', count: 5001 },
        },
      },
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

  it('refuses a run that starts or removes below zero, or at a fraction', () => {
    const splice = { handle: 0, text: 'body', runs: [{ index: 0, remove: 0, insert: '' }] }
    expect(documentEngine.textSpliceRequestSchema.safeParse(splice).success).toBe(true)
    for (const bad of [{ index: -1 }, { remove: -1 }, { index: 1.5 }]) {
      const runs = [{ index: 0, remove: 0, insert: '', ...bad }]
      expect(documentEngine.textSpliceRequestSchema.safeParse({ ...splice, runs }).success).toBe(
        false,
      )
    }
    expect(
      documentEngine.textSpliceRequestSchema.safeParse({ handle: 0, text: 'body', index: 0 })
        .success,
    ).toBe(false)
  })

  it('names what an import is judged by, and refuses another judge', () => {
    for (const judge of ['text', 'none']) {
      expect(
        documentEngine.importRequestSchema.safeParse({ handle: 0, bytes: 'AA==', judge }).success,
      ).toBe(true)
    }
    expect(documentEngine.importRequestSchema.safeParse({ handle: 0, bytes: 'AA==' }).success).toBe(
      true,
    )
    expect(
      documentEngine.importRequestSchema.safeParse({ handle: 0, bytes: 'AA==', judge: 'any' })
        .success,
    ).toBe(false)
  })

  it('asks a fork for a peer, and a decode for what it holds', () => {
    expect(documentEngine.forkRequestSchema.safeParse({ handle: 0 }).success).toBe(false)
    expect(documentEngine.forkRequestSchema.safeParse({ handle: 0, peer: '2' }).success).toBe(true)
    expect(documentEngine.decodeRequestSchema.safeParse({ bytes: 'AA==' }).success).toBe(false)
    expect(
      documentEngine.decodeRequestSchema.safeParse({ kind: 'other', bytes: 'AA==' }).success,
    ).toBe(false)
  })

  it('asks an export for what its mode needs: a shallow snapshot names its frontiers, or the version it is cut at', () => {
    const frontiers = [{ peer: '1', counter: 4 }]
    const requests = [
      { handle: 0, mode: 'snapshot' },
      { handle: 0, mode: 'update' },
      { handle: 0, mode: 'update', from: frontiers },
      { handle: 0, mode: 'shallow-snapshot', frontiers },
      { handle: 0, mode: 'shallow-snapshot-at-version', version: frontiers },
      { handle: 0, mode: 'removed-since', since: frontiers },
    ]
    for (const request of requests) {
      expect(
        documentEngine.exportRequestSchema.safeParse(request).success,
        JSON.stringify(request),
      ).toBe(true)
    }
    for (const bad of [
      { handle: 0, mode: 'shallow-snapshot' },
      { handle: 0, mode: 'shallow-snapshot-at-version' },
      { handle: 0, mode: 'shallow-snapshot-at-version', frontiers },
      { handle: 0, mode: 'removed-since' },
      { handle: 0, mode: 'removed-since', version: frontiers },
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
