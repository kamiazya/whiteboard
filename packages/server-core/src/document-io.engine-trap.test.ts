import type { LoadSnapshotInput, SaveSnapshotInput } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocumentEngineTrapError,
  loadDocument,
  loadOrCreateDocument,
  saveDocumentSnapshot,
} from './document-io.js'
import { setLogSink } from './log.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'

const WORKSPACE_ID = 'ws-trap'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

/** What loro-crdt's WASM throws when a Rust panic aborts a call. */
function engineTrap(): Error {
  const err = new Error('unreachable')
  err.name = 'RuntimeError'
  return err
}

class TrappingStore extends InMemoryDocumentStore {
  override async loadSnapshot(_input: LoadSnapshotInput): Promise<never> {
    throw engineTrap()
  }
  override async saveSnapshot(_input: SaveSnapshotInput): Promise<void> {
    throw engineTrap()
  }
}

const records: { level: string; msg: string; data?: Record<string, unknown> }[] = []

afterEach(() => {
  records.length = 0
  setLogSink(() => {})
})

describe('an engine abort while a document is loaded or saved', () => {
  const deps = () => makeTestDeps({ documentStore: new TrappingStore() })

  it.each([
    [
      'loadOrCreateDocument',
      () => loadOrCreateDocument(deps(), WORKSPACE_ID, DOCUMENT_ID),
      'loading',
    ],
    ['loadDocument', () => loadDocument(deps(), WORKSPACE_ID, DOCUMENT_ID), 'loading'],
    [
      'saveDocumentSnapshot',
      () => saveDocumentSnapshot(deps(), WORKSPACE_ID, DOCUMENT_ID, new LoroDoc()),
      'saving',
    ],
  ])('%s answers a typed error and logs the document at error', async (_name, run, doing) => {
    setLogSink((record) => records.push(record))

    const failure = await run().catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect((failure as DocumentEngineTrapError).message).toContain(`while ${doing} document`)
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        data: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          doing,
        }),
      }),
    )
  })

  it('leaves any other failure as it was thrown', async () => {
    class DiskFull extends InMemoryDocumentStore {
      override async saveSnapshot(): Promise<void> {
        throw new Error('disk full')
      }
    }
    await expect(
      saveDocumentSnapshot(
        makeTestDeps({ documentStore: new DiskFull() }),
        WORKSPACE_ID,
        DOCUMENT_ID,
        new LoroDoc(),
      ),
    ).rejects.toThrow('disk full')
  })
})
