import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)
// Cleared on BOTH sides. localStorage is a shared global that outlives a
// test file inside a worker, so leaving 'one' behind here silently put every
// later file's document browser into one-column mode — where `folder-contents`
// does not exist at all, and thirteen page tests failed on a missing element
// with nothing pointing back at this file.
beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

function renderPanel() {
  return render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({
        listDocuments: () =>
          Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
      })}
    />,
  )
}

// The column count is HOW you look, not WHAT at, so it is a per-device
// preference and not part of the address — a link someone shares must not
// impose the sender's layout on whoever opens it. That is the same line the
// open folder sits on the other side of.
describe('WorkspaceFilesPanel — column layout is a preference', () => {
  it('remembers the choice for next time', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'One column' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'One column' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    )

    cleanup()
    renderPanel()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'One column' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    )
  })

  // Storage can be unreadable (a private window, site data blocked) and can
  // hold anything at all — neither may cost the panel its default.
  it('falls back to two columns when the stored value is unusable', async () => {
    localStorage.setItem('whiteboard.document-browser.columns.v1', 'three')
    renderPanel()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Two columns' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    )
  })
})
