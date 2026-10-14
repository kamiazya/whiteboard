// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, type NavigateFunction, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEW_CANVAS_SHORTCUT } from '../lib/new-canvas-shortcut.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

afterEach(cleanup)

const { key, value } = NEW_CANVAS_SHORTCUT
const SHORTCUT = `${key}=${value}`

// The installed app's "New canvas" launcher shortcut lands on this page
// carrying `NEW_CANVAS_SHORTCUT`'s parameter. Reaching it through App's
// routing — the address sync rewrites `/` to the workspace's own address on
// the way — is App's to keep; this pins what the page does once the
// parameter arrives.
describe('the New canvas launcher shortcut on the list', () => {
  function renderAt(store: BrowserStoreDouble, entry: string) {
    const onOpenDocument = vi.fn()
    const at: { search: string; seen: string[]; go: NavigateFunction } = {
      search: '',
      seen: [],
      go: () => {},
    }
    function LocationProbe() {
      at.search = useLocation().search
      at.seen.push(at.search)
      at.go = useNavigate()
      return null
    }
    const page = () => (
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <BrowserIndexPage
          index={store.index}
          loro={store.loro}
          pointer={store.pointer}
          clock={store.clock}
          onOpenDocument={onOpenDocument}
        />
      </MemoryRouter>
    )
    render(page(), { container: document.body })
    return { onOpenDocument, at }
  }

  it('creates one canvas, opens it, and drops the parameter from the address', async () => {
    const store = new BrowserStoreDouble()
    const { onOpenDocument, at } = renderAt(store, `/w/default?${SHORTCUT}&folder=plans`)

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    const all = await store.listDocuments()
    expect(all).toHaveLength(1)
    expect(all[0]?.kind).toBe('spatial')
    expect(onOpenDocument).toHaveBeenCalledWith(all[0]?.path)
    // Only its own parameter goes: the open folder rides the same search.
    expect(at.search).toBe('?folder=plans')
  })

  it('Back after the shortcut does not return to the parameter and create again', async () => {
    const store = new BrowserStoreDouble()
    const { onOpenDocument, at } = renderAt(store, `/w/default?${SHORTCUT}&folder=plans`)
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(at.search).toBe('?folder=plans'))
    at.seen.length = 0

    // The parameter's entry was replaced, so there is no entry behind this one to go back to.
    act(() => at.go(-1))

    expect(at.seen.length).toBeGreaterThan(0)
    expect(at.seen.every((search) => search === '?folder=plans')).toBe(true)
    expect(onOpenDocument).toHaveBeenCalledTimes(1)
    expect(await store.listDocuments()).toHaveLength(1)
  })

  it('a refused create says so in place and still drops the parameter', async () => {
    const store = new BrowserStoreDouble()
    store.index.createDocument = () => Promise.reject(new Error('quota exceeded'))
    const { onOpenDocument, at } = renderAt(store, `/w/default?${SHORTCUT}`)

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Failed to create a canvas in this browser.',
    )
    expect(at.search).toBe('')
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('a later visit to the shortcut retries a create that failed', async () => {
    const store = new BrowserStoreDouble()
    const create = store.index.createDocument.bind(store.index)
    let refusals = 1
    store.index.createDocument = (input) =>
      refusals-- > 0 ? Promise.reject(new Error('quota exceeded')) : create(input)
    const { onOpenDocument, at } = renderAt(store, `/w/default?${SHORTCUT}`)
    await screen.findByRole('alert')
    await waitFor(() => expect(at.search).toBe(''))

    act(() => at.go(`/w/default?${SHORTCUT}`))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    expect(await store.listDocuments()).toHaveLength(1)
  })

  it('another value of the parameter creates nothing', async () => {
    const store = new BrowserStoreDouble()
    const { onOpenDocument } = renderAt(store, `/w/default?${key}=note`)

    await screen.findByText('What will you make first?')
    expect(onOpenDocument).not.toHaveBeenCalled()
    expect(await store.listDocuments()).toHaveLength(0)
  })
})
