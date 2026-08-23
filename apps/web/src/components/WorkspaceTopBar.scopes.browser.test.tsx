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
import { BrowserDocumentPage } from '../pages/BrowserDocumentPage.js'
import WorkspaceTopBar from './WorkspaceTopBar.js'
import '../index.css'

afterEach(cleanup)

function renderTopBar(props?: Partial<ComponentProps<typeof WorkspaceTopBar>>) {
  return render(
    <div className="h-[200px] w-[1100px] bg-background p-6">
      <WorkspaceTopBar workspaceId="local" path="my-canvas" {...props} />
    </div>,
  )
}

describe('top bar scopes', () => {
  it("offers no way to reach another document — finding one is the browser's job", () => {
    // `onNavigateBack` supplied deliberately: the control renders only when
    // the host page wires it, so asserting without it would pass vacuously.
    renderTopBar({ workspaceId: 'local', path: 'my-canvas', onNavigateBack: () => {} })
    expect(screen.queryByRole('button', { name: /workspace/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to documents' })).toBeTruthy()
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
    expect(screen.queryByLabelText('Document title')).toBeNull()
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
    // In memory, and ALL FOUR of them: every browser test file shares one
    // origin, and a sibling deleting the shared database used to land
    // mid-load here, leaving the page stuck loading. Files now claim private
    // databases (claimIsolatedWhiteboardDb) and a scan bars the shared name,
    // but in-memory stays right regardless: the assertion is about a CSS
    // ground, so the storage backend is incidental.
    //
    // All four, not just the index: the page's `loro`, `pointer` and `clock`
    // each default to real IndexedDB, so an in-memory index beside three real
    // ones is not isolated at all. Measured idle this costs only ~5ms
    // (34ms vs 39ms to first `<main>`), so it is NOT what failed in CI — the
    // budget below is. It is here because the isolation this file asks for in
    // the comment above is a property of all four or of none.
    const local = new LocalStoreDouble()
    render(
      <div style={{ height: '400px' }}>
        <MemoryRouter initialEntries={['/']}>
          <BrowserDocumentPage
            store={local.index}
            loro={local.loro}
            pointer={local.pointer}
            clock={local.clock}
          />
        </MemoryRouter>
      </div>,
    )

    // `<main>` is the element that goes fullscreen. Once it does, it is
    // promoted to the top layer and the BODY's background stops showing —
    // anything `<main>` does not paint itself falls through to the default
    // black backdrop, which is what made the canvas area go black under a
    // light theme.
    // An explicit budget, like every sibling in this project. The default is
    // 1000ms, and the whole browser project in flight makes a test 20-30x
    // slower than the same file alone — so a mount measured at ~35ms idle has
    // no margin at all under a full run. That is what failed in CI.
    const main = await waitFor(
      () => {
        const el = document.querySelector('main')
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 5000 },
    )
    const background = getComputedStyle(main).backgroundColor
    expect(background).not.toBe('rgba(0, 0, 0, 0)')
    expect(background).not.toBe('transparent')
  })
})
