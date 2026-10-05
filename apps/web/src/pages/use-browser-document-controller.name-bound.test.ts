import { DOCUMENT_NAME_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

const C1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

/** The controller, loaded on one stored document named `name`. */
async function openNamed(name: string) {
  const store = new BrowserStoreDouble()
  await store.setDefaultDocumentId(C1)
  await store.save({
    documentId: C1,
    workspaceId: getBrowserWorkspaceId(),
    path: 'untitled',
    name,
    updatedAt: '2026-05-24T00:00:00.000Z',
    kind: 'spatial',
  })
  const { result } = renderHook(() =>
    useBrowserDocumentController(store.index, {
      loro: store.loro,
      pointer: store.pointer,
      clock: store.clock,
    }),
  )
  await act(async () => {})
  return { store, result }
}

// The bound is the index port's, and refusing it there came AFTER the
// snapshot already showed the name: the header held a name the store never
// took, the page read the parse failure as a failed save, and Delete then
// refused until some later rename saved.
describe('a rename past the name bound', () => {
  it('is refused before it is shown, and leaves Delete free', async () => {
    const { store, result } = await openNamed('Release plan')

    let refusal: unknown
    await act(async () => {
      refusal = await result.current
        .renameDocument('n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1))
        .catch((err: unknown) => err)
    })

    expect(refusal).toBeInstanceOf(z.ZodError)
    expect(result.current.persistence.kind).toBe('saved')
    expect(result.current.snapshot?.name).toBe('Release plan')
    expect((await store.load(C1))?.name).toBe('Release plan')
    await act(async () => {
      await result.current.deleteDocument()
    })
    expect(await store.load(C1)).toBeNull()
  })

  it('still takes a name exactly at the bound', async () => {
    const { store, result } = await openNamed('untitled')
    const longest = 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH)

    await act(async () => {
      await result.current.renameDocument(longest)
    })

    expect(result.current.persistence.kind).toBe('saved')
    expect((await store.load(C1))?.name).toBe(longest)
  })
})
