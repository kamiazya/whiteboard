import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

const GONE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

it('an open abandoned while recovering a stale pointer seeds and repoints nothing', async () => {
  const store = new LocalStoreDouble()
  await store.pointer.set(GONE)
  // The recovery lists what is left; park that listing until the page is gone.
  let release = () => {}
  let announce = () => {}
  const arrived = new Promise<void>((resolve) => {
    announce = resolve
  })
  const listDocuments = store.index.listDocuments.bind(store.index)
  // Only the first call parks: seeding lists again to pick a free path, and
  // a gate that caught that one too would stall the very write under test.
  vi.spyOn(store.index, 'listDocuments').mockImplementationOnce(async (query) => {
    announce()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return listDocuments(query)
  })
  const { unmount } = renderHook(() =>
    useBrowserDocumentController(store.index, {
      pointer: store.pointer,
      clock: store.clock,
      loro: store.loro,
    }),
  )
  await arrived
  unmount()
  release()

  // Every store here is in memory, so one macrotask drains the abandoned
  // open's whole promise chain — a seed and a repoint included, were it to run.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await store.pointer.get()).toBe(GONE)
  expect(await listDocuments({ workspaceId: getBrowserWorkspaceId() })).toEqual([])
})
