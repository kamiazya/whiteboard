/**
 * The two header rows own different SCOPES.
 *
 * Row one is where you ARE — the application and the workspace. Row two
 * (DocumentProperties) is the canvas itself: its title, its state, its
 * operations. Anything canvas-shaped in row one is a duplicate of something
 * row two already owns, and the canvas name was appearing in both.
 */

import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
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
})
