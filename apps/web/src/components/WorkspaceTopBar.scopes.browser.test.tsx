import { LocalStoreDouble } from '../test-utils/local-index.js'
/**
 * The two header rows own different SCOPES.
 *
 * Row one is where you ARE — the application and the workspace. Row two
 * (DocumentProperties) is the canvas itself: its title, its state, its
 * operations. Anything canvas-shaped in row one is a duplicate of something
 * row two already owns, and the canvas name was appearing in both.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserLocalDocumentPage } from '../pages/BrowserLocalDocumentPage.js'
import WorkspaceTopBar from './WorkspaceTopBar.js'
import '../index.css'

afterEach(cleanup)

function renderTopBar(props?: Partial<ComponentProps<typeof WorkspaceTopBar>>) {
  return render(
    <div className="h-[200px] w-[1100px] bg-background p-6">
      <WorkspaceTopBar
        workspaceId="local"
        path="my-canvas"
        documents={[{ path: 'my-canvas', updatedAt: '2026-04-24T11:00:00Z' }]}
        onNavigateToDocument={() => {}}
        {...props}
      />
    </div>,
  )
}

describe('top bar scopes', () => {
  it('names the workspace, not the canvas, on the switcher trigger', () => {
    renderTopBar({ workspaceId: 'local', path: 'my-canvas' })
    // The canvas name belongs to row two's title field. Row one says where
    // you are, and picking a canvas is navigation WITHIN that workspace.
    expect(screen.queryByRole('button', { name: /my-canvas/ })).toBeNull()
    expect(screen.getByRole('button', { name: /workspace/i })).toBeTruthy()
  })

  it('offers no theme control — Settings already owns the full three-way choice', () => {
    // Supplied deliberately: the button only rendered when BOTH theme props
    // were passed, so asserting without them would pass vacuously and go on
    // passing after the button came back.
    renderTopBar({ theme: 'system', onToggleTheme: () => {} } as Partial<
      ComponentProps<typeof WorkspaceTopBar>
    >)
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull()
  })

  it("no longer offers rename — row two's title field IS the rename", () => {
    renderTopBar()
    // Copy-URL and export still live in row one's menu: moving them needs
    // canvas-name resolution lifted out of this component, which the
    // identity-model work owns. Rename is the part that duplicated row two.
    expect(screen.queryByRole('menuitem', { name: /rename/i })).toBeNull()
    expect(screen.queryByLabelText('Canvas title')).toBeNull()
  })

  it('toggles fullscreen rather than only entering it', async () => {
    const onToggleFullscreen = vi.fn()
    renderTopBar({ onToggleFullscreen })

    // The header stays INSIDE the fullscreen element, so it is the exit
    // affordance too — without a toggle there is no way back from the header.
    await userEvent.click(screen.getByRole('button', { name: /fullscreen/i }))
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1)
  })

  it('reports the exit affordance when already fullscreen', () => {
    renderTopBar({ isFullscreen: true, onToggleFullscreen: () => {} })
    expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeTruthy()
  })
})

describe('fullscreen ground', () => {
  it('paints the fullscreen target itself, not just the body behind it', async () => {
    // LocalStoreDouble, not LocalStoreDouble: every browser test file shares one
    // origin, so a sibling file's `indexedDB.deleteDatabase('whiteboard')`
    // lands mid-load here and the page never leaves its loading state. The
    // assertion is about a CSS ground, so the storage backend is incidental.
    render(
      <div style={{ height: '400px' }}>
        <MemoryRouter initialEntries={['/']}>
          <BrowserLocalDocumentPage store={new LocalStoreDouble().index} />
        </MemoryRouter>
      </div>,
    )

    // `<main>` is the element that goes fullscreen. Once it does, it is
    // promoted to the top layer and the BODY's background stops showing —
    // anything `<main>` does not paint itself falls through to the default
    // black backdrop, which is what made the canvas area go black under a
    // light theme.
    const main = await waitFor(() => {
      const el = document.querySelector('main')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    const background = getComputedStyle(main).backgroundColor
    expect(background).not.toBe('rgba(0, 0, 0, 0)')
    expect(background).not.toBe('transparent')
  })
})
