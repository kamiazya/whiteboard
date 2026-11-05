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

// The index refuses a sibling's name only after the snapshot showed it: the
// title box read the refusal as a failed save, persistence went degraded and
// Delete then refused.
describe('a rename to a name a sibling already shows', () => {
  it('is refused with the keeper sentence before it is shown, and leaves Delete free', async () => {
    const { store, result } = await openNamed('Release plan')
    await store.save({
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      workspaceId: getBrowserWorkspaceId(),
      path: 'other',
      name: 'Roadmap',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial',
    })

    let refusal: unknown
    await act(async () => {
      refusal = await result.current.renameDocument(' roadmap ').catch((err: unknown) => err)
    })

    expect((refusal as Error).message).toMatch(/already called/)
    expect(result.current.persistence.kind).toBe('saved')
    expect(result.current.snapshot?.name).toBe('Release plan')
    expect((await store.load(C1))?.name).toBe('Release plan')
    await act(async () => {
      await result.current.deleteDocument()
    })
    expect(await store.load(C1)).toBeNull()
  })
})

// A rename typed while a refused one is still being written used to wait on
// it, see it fail, and give up: the newer name was neither stored nor
// reported, persistence read "saved", and a reload lost it.
describe('a rename made while a refused rename is still being written', () => {
  it('is stored, and only the refused rename hears the refusal', async () => {
    const { store, result } = await openNamed('Release plan')
    await store.save({
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      workspaceId: getBrowserWorkspaceId(),
      path: 'other',
      name: 'Roadmap',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial',
    })
    const write = store.index.setDocumentName.bind(store.index)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    store.index.setDocumentName = async (input) => {
      calls += 1
      if (calls === 1) await held
      return write(input)
    }

    let refused: Promise<unknown> = Promise.resolve()
    let renamed: Promise<unknown> = Promise.resolve()
    await act(async () => {
      refused = result.current.renameDocument('Roadmap').catch((err: unknown) => err)
    })
    await act(async () => {
      renamed = result.current.renameDocument('Budget').then(
        () => 'stored',
        (err: unknown) => err,
      )
    })
    await act(async () => {
      release()
      await Promise.all([refused, renamed])
    })

    expect(((await refused) as Error).message).toMatch(/already called/)
    expect(await renamed).toBe('stored')
    expect((await store.load(C1))?.name).toBe('Budget')
    expect(result.current.snapshot?.name).toBe('Budget')
    expect(result.current.persistence.kind).toBe('saved')
  })
})
