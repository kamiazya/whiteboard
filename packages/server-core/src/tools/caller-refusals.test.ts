import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { describe, expect, it, vi } from 'vitest'
import { SnapshotNotFoundError } from '../document-io.js'
import {
  inTheCallersWords,
  ownsWorkspaceRefusal,
  unknownWorkspaceRefusal,
} from './caller-refusals.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'

// `caller-refusals.ts` has no test of its own: its behaviour is reached only through whole-route and
// whole-tool tests. This pins what each branch promises, so a change to one cannot hide behind a route
// that happens to pass for another reason.
const WS = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function indexHolding(held: boolean) {
  const resolveDocumentById = vi.fn(async () => (held ? { documentId: 'd' } : null))
  return { index: { resolveDocumentById } as unknown as DocumentIndex, resolveDocumentById }
}

describe('inTheCallersWords', () => {
  it('re-says EVERY occurrence of the canonical id in the handle the caller typed, keeping name and cause', async () => {
    const original = new RangeError(`first ${WS}, then ${WS} again`)
    original.name = 'SomeToolError'
    const said = (await inTheCallersWords(original, {
      index: indexHolding(true).index,
      handle: 'plans',
      workspaceId: WS,
      documentId: undefined,
    })) as Error
    expect(said).not.toBe(original)
    expect(said.message).toBe('first plans, then plans again')
    expect(said.name).toBe('SomeToolError')
    expect(said.cause).toBe(original)
  })

  it('hands back the very same error when there is nothing to re-say', async () => {
    const { index } = indexHolding(true)
    const unrelated = new Error('no id in here')
    expect(
      await inTheCallersWords(unrelated, {
        index,
        handle: 'plans',
        workspaceId: WS,
        documentId: undefined,
      }),
    ).toBe(unrelated)
    const named = new Error(`about ${WS}`)
    expect(
      await inTheCallersWords(named, { index, handle: WS, workspaceId: WS, documentId: undefined }),
    ).toBe(named)
    const notAnError = { message: WS }
    expect(
      await inTheCallersWords(notAnError, {
        index,
        handle: 'plans',
        workspaceId: WS,
        documentId: undefined,
      }),
    ).toBe(notAnError)
  })

  it('a missing snapshot for a document the workspace does not hold is a missing DOCUMENT, in the caller words', async () => {
    const { index } = indexHolding(false)
    const said = await inTheCallersWords(new SnapshotNotFoundError('D1'), {
      index,
      handle: 'plans',
      workspaceId: WS,
      documentId: 'D1',
    })
    expect(said).toBeInstanceOf(WorkspaceDocumentNotFoundError)
    expect((said as WorkspaceDocumentNotFoundError).message).toBe(
      'Document not found: D1 in workspace plans',
    )
  })

  it('a missing snapshot for a document the workspace DOES hold keeps saying so', async () => {
    const { index } = indexHolding(true)
    const original = new SnapshotNotFoundError('D1')
    expect(
      await inTheCallersWords(original, {
        index,
        handle: 'plans',
        workspaceId: WS,
        documentId: 'D1',
      }),
    ).toBe(original)
  })

  it('never asks the index about a document id that is not a string', async () => {
    const { index, resolveDocumentById } = indexHolding(false)
    const original = new SnapshotNotFoundError('D1')
    expect(
      await inTheCallersWords(original, {
        index,
        handle: 'plans',
        workspaceId: WS,
        documentId: undefined,
      }),
    ).toBe(original)
    expect(resolveDocumentById).not.toHaveBeenCalled()
  })
})

describe('unknownWorkspaceRefusal', () => {
  it('lists the workspaces that do exist when the keeper can say, and says nothing of them when it cannot', async () => {
    const withList = await unknownWorkspaceRefusal('nope', async () => ['plans', 'ops'])
    expect(withList.message).toContain('Workspaces here: "plans", "ops".')
    const without = await unknownWorkspaceRefusal('nope', undefined)
    expect(without.message).not.toContain('Workspaces here')
    // a read: no `createWorkspace` parameter to offer on the call itself
    expect(without.message).not.toContain('Pass createWorkspace: true on this')
  })
})

describe('ownsWorkspaceRefusal', () => {
  it('is true only for a tool whose input shape takes createWorkspace', () => {
    expect(ownsWorkspaceRefusal({ inputSchema: { shape: { createWorkspace: {} } } })).toBe(true)
    expect(ownsWorkspaceRefusal({ inputSchema: { shape: { workspaceId: {} } } })).toBe(false)
    expect(ownsWorkspaceRefusal({})).toBe(false)
  })
})
