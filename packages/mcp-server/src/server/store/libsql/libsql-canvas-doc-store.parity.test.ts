import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CanvasDocStore,
  DeltaBatch,
  DocRef,
  LoadDeltasResult,
  LoadSnapshotResult,
  ReadFrontierResult,
  SnapshotChunk,
  SnapshotManifest,
} from '@kamiazya/whiteboard-canvas-ports'
import { describe, expect } from 'vitest'
import { fc, fcTest } from '../../../shared/test-utils/fast-check.js'
import { createIsolatedDb } from '../db/test-helpers.js'
import { InMemoryCanvasDocStore } from '../inmemory/in-memory-canvas-doc-store.js'
import { LibsqlCanvasDocStore } from './libsql-canvas-doc-store.js'

// Fixed pool of docRefs, including a canvas/workspace-tree pair that share an
// id string, so the model exercises the isolation boundary in addition to
// plain multi-doc isolation.
const DOC_REFS: readonly DocRef[] = [
  { kind: 'canvas', canvasId: 'shared-id' },
  { kind: 'canvas', canvasId: 'other-canvas' },
  { kind: 'workspace-tree', workspaceId: 'shared-id' },
]

type SaveSnapshotOp = {
  type: 'saveSnapshot'
  docRefIndex: number
  chunkByteArrays: Uint8Array[]
  frontier: Uint8Array
}

type AppendDeltasOp = {
  type: 'appendDeltas'
  docRefIndex: number
  updates: Uint8Array[]
  newFrontier: Uint8Array
}

type DeleteDocOp = {
  type: 'deleteDoc'
  docRefIndex: number
}

type Op = SaveSnapshotOp | AppendDeltasOp | DeleteDocOp

function buildSnapshotArgs(chunkByteArrays: Uint8Array[]): {
  manifest: SnapshotManifest
  chunks: SnapshotChunk[]
} {
  const chunkCount = chunkByteArrays.length
  const totalBytes = chunkByteArrays.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  const maxChunkBytes = Math.max(1, ...chunkByteArrays.map((bytes) => bytes.byteLength))
  const chunks: SnapshotChunk[] = chunkByteArrays.map((bytes, index) => ({
    index,
    of: Math.max(chunkCount, 1),
    bytes,
  }))
  return { manifest: { chunkCount, totalBytes, maxChunkBytes }, chunks }
}

async function applyOp(store: CanvasDocStore, op: Op): Promise<void> {
  const docRef = DOC_REFS[op.docRefIndex] as DocRef
  if (op.type === 'saveSnapshot') {
    const { manifest, chunks } = buildSnapshotArgs(op.chunkByteArrays)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: op.frontier })
  } else if (op.type === 'appendDeltas') {
    const deltaBatch: DeltaBatch = { updates: op.updates, newFrontier: op.newFrontier }
    await store.appendDeltas({ docRef, deltaBatch })
  } else {
    await store.deleteDoc({ docRef })
  }
}

interface Observation {
  snapshot: LoadSnapshotResult
  deltas: LoadDeltasResult
  frontier: ReadFrontierResult
}

async function observe(store: CanvasDocStore, docRef: DocRef): Promise<Observation> {
  return {
    snapshot: await store.loadSnapshot({ docRef }),
    deltas: await store.loadDeltas({ docRef, sinceFrontier: new Uint8Array() }),
    frontier: await store.readFrontier({ docRef }),
  }
}

async function observeAll(store: CanvasDocStore): Promise<Observation[]> {
  return Promise.all(DOC_REFS.map((docRef) => observe(store, docRef)))
}

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    type: fc.constant('saveSnapshot' as const),
    docRefIndex: fc.integer({ min: 0, max: DOC_REFS.length - 1 }),
    chunkByteArrays: fc.array(fc.uint8Array({ minLength: 1, maxLength: 5 }), { maxLength: 3 }),
    frontier: fc.uint8Array({ maxLength: 5 }),
  }),
  fc.record({
    type: fc.constant('appendDeltas' as const),
    docRefIndex: fc.integer({ min: 0, max: DOC_REFS.length - 1 }),
    updates: fc.array(fc.uint8Array({ maxLength: 5 }), { minLength: 1, maxLength: 3 }),
    newFrontier: fc.uint8Array({ maxLength: 5 }),
  }),
  // Deleting is generated alongside the writes rather than only after them:
  // what a partial delete leaves behind (an orphan frontier, a delta run with
  // no snapshot) is only observable when a later op reads or rewrites the
  // same docKey.
  fc.record({
    type: fc.constant('deleteDoc' as const),
    docRefIndex: fc.integer({ min: 0, max: DOC_REFS.length - 1 }),
  }),
)

describe('LibsqlCanvasDocStore / InMemoryCanvasDocStore observational parity', () => {
  // Each property run gets its own fresh isolated DB (created/disposed inside
  // the property body, not in beforeEach/afterEach) so state from one
  // generated op sequence never leaks into the next run's docKey rows.
  fcTest.prop([fc.array(opArbitrary, { maxLength: 12 })], { numRuns: 20 })(
    'stay observationally equivalent after every step of a random op sequence',
    async (ops) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-libsql-doc-store-parity-'))
      const handle = await createIsolatedDb({ dataDir: tempDir })
      try {
        const inMemory = new InMemoryCanvasDocStore()
        const libsql = new LibsqlCanvasDocStore(handle.db)

        for (const op of ops) {
          await applyOp(inMemory, op)
          await applyOp(libsql, op)

          const [inMemoryObs, libsqlObs] = await Promise.all([
            observeAll(inMemory),
            observeAll(libsql),
          ])
          expect(libsqlObs).toEqual(inMemoryObs)
        }
      } finally {
        await handle.dispose()
        await rm(tempDir, { recursive: true, force: true })
      }
    },
  )
})
