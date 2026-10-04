import type { SaveSnapshotInput } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentEngineTrapError } from '../document-io.js'
import { setLogSink } from '../log.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'

const WS = 'failed-write'
const MARKDOWN = '---\ntype: note\n---\nthe body'

/** A store whose Nth save throws, standing in for whatever fails once the document exists. */
class StoreFailingOnSave extends InMemoryDocumentStore {
  saves = 0
  constructor(
    private readonly failOn: number,
    private readonly failure: () => unknown,
  ) {
    super()
  }
  override async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    this.saves += 1
    if (this.saves === this.failOn) throw this.failure()
    return super.saveSnapshot(input)
  }
}

async function depsOver(store: InMemoryDocumentStore) {
  const deps = makeTestDeps({ documentStore: store, documentTeardown: inMemoryDocumentTeardown() })
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  return deps
}

const paths = async (deps: Awaited<ReturnType<typeof depsOver>>) =>
  (await deps.documentIndex.listDocuments({ workspaceId: WS })).map((d) => d.path)

afterEach(() => setLogSink(() => {}))

describe('a create whose write fails after the document was placed', () => {
  // Save 1 is the kind marker, save 2 the body: either can fail once the index
  // holds the path, and a retry must not collide with what it left.
  it.each([
    [1, 'the kind marker'],
    [2, 'the body'],
  ])('removes the half-created document when %s save fails', async (failOn) => {
    const store = new StoreFailingOnSave(failOn, () => new Error('disk full'))
    const deps = await depsOver(store)

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'ghost',
        kind: 'markdown',
        markdown: MARKDOWN,
      }),
    ).rejects.toThrow('disk full')

    expect(await paths(deps)).toEqual([])
    // The path is free again, which is what the caller's retry needs.
    const retried = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'ghost',
      kind: 'markdown',
      markdown: MARKDOWN,
    })
    expect(retried.path).toBe('ghost')
  })

  it('still reports the original failure when the cleanup cannot run', async () => {
    const store = new StoreFailingOnSave(2, () => new Error('disk full'))
    const deps = makeTestDeps({ documentStore: store })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const records: { level: string; msg: string }[] = []
    setLogSink((record) => records.push(record))

    // The default teardown refuses, so the cleanup throws; the caller must
    // still learn why the create failed, not why the cleanup did.
    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'ghost',
        kind: 'markdown',
        markdown: MARKDOWN,
      }),
    ).rejects.toThrow('disk full')
    expect(records.some((r) => r.level === 'error' && /half-created/.test(r.msg))).toBe(true)
  })
})

describe('a create during which the CRDT engine traps', () => {
  const trap = () => {
    const err = new Error('unreachable')
    err.name = 'RuntimeError'
    return err
  }

  it('refuses with a typed error, logs at error with the document, and leaves no ghost', async () => {
    const store = new StoreFailingOnSave(2, trap)
    const deps = await depsOver(store)
    const records: { level: string; msg: string; data?: Record<string, unknown> }[] = []
    setLogSink((record) => records.push(record))

    const failure = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'trapped',
      kind: 'markdown',
      markdown: MARKDOWN,
    }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect(await paths(deps)).toEqual([])
    const logged = records.find((r) => r.level === 'error' && /trap/i.test(r.msg))
    expect(logged?.data).toMatchObject({ workspaceId: WS, documentId: expect.any(String) })
  })
})
