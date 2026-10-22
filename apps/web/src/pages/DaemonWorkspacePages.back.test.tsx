/**
 * "Back to documents" from a daemon-kept document lands in the folder the
 * document sat in, the way the browser keeper's page does.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonWorkspacePages } from './DaemonWorkspacePages.js'

vi.mock('./DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: ({ onNavigateBack }: { onNavigateBack?: () => void }) => (
    <button type="button" onClick={onNavigateBack}>
      back
    </button>
  ),
}))

afterEach(cleanup)

async function pressBackFrom(path: string) {
  const onView = vi.fn()
  render(
    <DaemonWorkspacePages
      daemonBaseUrl="http://127.0.0.1:3099"
      view={{ kind: 'document', workspace: 'w1', path }}
      onView={onView}
      waitingMessage="waiting"
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'back' }))
  return onView
}

describe('DaemonWorkspacePages Back', () => {
  it('opens the folder the document sat in', async () => {
    const onView = await pressBackFrom('notes/2026/plan')
    expect(onView).toHaveBeenCalledWith({ kind: 'index', workspace: 'w1', folder: 'notes/2026' })
  })

  it('opens the workspace root for a root-level document', async () => {
    const onView = await pressBackFrom('plan')
    expect(onView).toHaveBeenCalledWith({ kind: 'index', workspace: 'w1', folder: '' })
  })
})
