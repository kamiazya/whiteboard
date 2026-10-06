import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

const C1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

/** The controller over `store`, loaded — a fresh mount is a page reload. */
async function open(store: BrowserStoreDouble) {
  const { result, unmount } = renderHook(() =>
    useBrowserDocumentController(store.index, {
      loro: store.loro,
      pointer: store.pointer,
      clock: store.clock,
    }),
  )
  await act(async () => {})
  return { result, unmount }
}

async function unnamedAt(path: string) {
  const store = new BrowserStoreDouble()
  await store.setDefaultDocumentId(C1)
  await store.save({
    documentId: C1,
    workspaceId: getBrowserWorkspaceId(),
    path,
    name: null,
    updatedAt: '2026-05-24T00:00:00.000Z',
    kind: 'spatial',
  })
  return store
}

// Unnamed is spelled null, as the daemon spells it — so a name that happens
// to equal the path is a name like any other, not a way of saying "none".
describe('an unnamed browser document', () => {
  it('loads with no name rather than its path standing in for one', async () => {
    const store = await unnamedAt('plans/q3')
    const { result } = await open(store)
    expect(result.current.snapshot?.path).toBe('plans/q3')
    expect(result.current.snapshot?.name).toBeNull()
  })

  it('keeps a typed title equal to its path as a name across a reload', async () => {
    const store = await unnamedAt('plans/q3')
    const first = await open(store)
    await act(async () => {
      await first.result.current.renameDocument('plans/q3')
    })
    expect(first.result.current.snapshot?.name).toBe('plans/q3')
    first.unmount()

    const reloaded = await open(store)
    expect(reloaded.result.current.snapshot?.name).toBe('plans/q3')
  })

  it('goes back to no name when its title is cleared', async () => {
    const store = await unnamedAt('plans/q3')
    const first = await open(store)
    await act(async () => {
      await first.result.current.renameDocument('Quarter plan')
    })
    await act(async () => {
      await first.result.current.renameDocument('   ')
    })
    expect(first.result.current.snapshot?.name).toBeNull()
    first.unmount()

    const reloaded = await open(store)
    expect(reloaded.result.current.snapshot?.name).toBeNull()
  })
})
