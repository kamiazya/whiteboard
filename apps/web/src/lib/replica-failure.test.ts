/**
 * What a failed replica pull or push tells the person, by what actually
 * failed. Both `try` blocks cover the network AND this device's own storage,
 * and a device failure reported as an unreachable daemon sends someone to
 * check a connection that works — with nothing in the log to say otherwise.
 */
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { cacheDaemonWorkspace } from './replica-cache.js'
import { PULL_FAILURE_COPY, PUSH_FAILURE_COPY } from './replica-failure.js'
import { pushReplicaEdits } from './replica-push.js'
import { unmarkReplica } from './replica-store.js'
import { ReplicaKeyWithheldError } from './sealed-document-store.js'

const BASE = 'http://127.0.0.1:3099'
const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FE0'
/**
 * The record a device-side failure leaves names the error, since the sentence
 * the person reads carries none of it. Spied through, so the setup's
 * logged-failure interception still sees the record.
 */
async function expectDeviceFailureLogged(message: string, name: string): Promise<void> {
  await expectLoggedFailure(message)
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining(message),
    expect.objectContaining({ name }),
  )
}

function unused(): never {
  throw new Error('not reached by these cases')
}

function workspaceDocs(overrides: Partial<WorkspaceDocs>): WorkspaceDocs {
  return {
    open: async () => null,
    create: unused,
    save: async () => null,
    readCursor: unused,
    catchUp: unused,
    ...overrides,
  }
}

function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/plan',
    documentId: '01ARZ3NDEKTSV4RRFFQ69G5FE1',
    kind: 'markdown',
  })
  return doc
}

function snapshotFetch(): typeof globalThis.fetch {
  const bytes = record().export({ mode: 'snapshot' })
  return (async () => new Response(bytes as BodyInit, { status: 200 })) as typeof globalThis.fetch
}

const offline = (async () => {
  throw new TypeError('Failed to fetch')
}) as typeof globalThis.fetch

const unreadable = async (): Promise<never> => {
  throw new StoredDocumentUnreadableError('malformed', 'a delta does not decode')
}

const withheld = async (): Promise<never> => {
  throw new ReplicaKeyWithheldError(DAEMON_WS)
}

const quotaExceeded = async (): Promise<never> => {
  throw new DOMException('the quota has been exceeded', 'QuotaExceededError')
}

// What a defect in this device's own read or write throws — the same class a
// failed fetch rejects with, which is why the class alone cannot say network.
const localTypeError = async (): Promise<never> => {
  throw new TypeError("Cannot read properties of undefined (reading 'export')")
}

afterEach(() => {
  unmarkReplica(DAEMON_WS)
  vi.restoreAllMocks()
})

describe('cacheDaemonWorkspace failure reasons', () => {
  const pull = (fetch: typeof globalThis.fetch, docs: WorkspaceDocs) =>
    cacheDaemonWorkspace({
      fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
    })

  it('a fetch that throws is reported as an unreachable daemon', async () => {
    const result = await pull(offline, workspaceDocs({}))
    expect(result).toEqual({ kind: 'failed', reason: PULL_FAILURE_COPY.network })
  })

  it('a withheld session key is reported as withheld, not as a failure', async () => {
    expect(await pull(snapshotFetch(), workspaceDocs({ open: withheld }))).toEqual({
      kind: 'withheld',
    })
  })

  it('an unreadable stored copy is reported as unreadable and logged', async () => {
    const result = await pull(snapshotFetch(), workspaceDocs({ open: unreadable }))
    expect(result).toEqual({ kind: 'failed', reason: PULL_FAILURE_COPY.unreadable })
    await expectLoggedFailure(PULL_FAILURE_COPY.unreadableLog)
  })

  it('a save this device refuses is reported as a storage failure and logged', async () => {
    vi.spyOn(console, 'warn')
    const result = await pull(snapshotFetch(), workspaceDocs({ save: quotaExceeded }))
    expect(result).toEqual({ kind: 'failed', reason: PULL_FAILURE_COPY.device })
    await expectDeviceFailureLogged(PULL_FAILURE_COPY.deviceLog, 'QuotaExceededError')
  })

  it('a TypeError from the local save is a device failure, not a network one', async () => {
    const result = await pull(snapshotFetch(), workspaceDocs({ save: localTypeError }))
    if (result.kind !== 'failed') throw new Error(`expected a failed pull, got ${result.kind}`)
    expect(result.reason).toMatch(/could not be stored on this device/)
    await expectLoggedFailure('replica pull failed on this device')
  })
})

describe('pushReplicaEdits failure reasons', () => {
  const push = (fetch: typeof globalThis.fetch, docs: WorkspaceDocs) =>
    pushReplicaEdits({ fetch, daemonBaseUrl: BASE, workspaceId: DAEMON_WS, workspaceDocs: docs })

  it('a fetch that throws is reported as an unreachable daemon', async () => {
    const result = await push(offline, workspaceDocs({ open: async () => record() }))
    expect(result).toEqual({ kind: 'failed', reason: PUSH_FAILURE_COPY.network })
  })

  it('a withheld session key is reported as withheld, not as a failure', async () => {
    expect(await push(offline, workspaceDocs({ open: withheld }))).toEqual({ kind: 'withheld' })
  })

  it('an unreadable stored copy is reported as unreadable and logged', async () => {
    const result = await push(offline, workspaceDocs({ open: unreadable }))
    expect(result).toEqual({ kind: 'failed', reason: PUSH_FAILURE_COPY.unreadable })
    await expectLoggedFailure(PUSH_FAILURE_COPY.unreadableLog)
  })

  it('a local copy this device cannot open is reported as a device failure and logged', async () => {
    vi.spyOn(console, 'warn')
    const result = await push(offline, workspaceDocs({ open: quotaExceeded }))
    expect(result).toEqual({ kind: 'failed', reason: PUSH_FAILURE_COPY.device })
    await expectDeviceFailureLogged(PUSH_FAILURE_COPY.deviceLog, 'QuotaExceededError')
  })

  it('a TypeError from opening the local copy is a device failure, not a network one', async () => {
    const result = await push(offline, workspaceDocs({ open: localTypeError }))
    if (result.kind !== 'failed') throw new Error(`expected a failed push, got ${result.kind}`)
    expect(result.reason).toMatch(/on this device/)
    await expectLoggedFailure('replica push failed on this device')
  })
})
