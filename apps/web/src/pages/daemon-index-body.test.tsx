/**
 * The empty workspace's copy names who keeps the documents — the local
 * daemon, or the server a server-mode keeper is (ADR-0047).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonIndexBody } from './daemon-index-body.js'

afterEach(cleanup)

function emptyWorkspace(serverMode: boolean) {
  render(
    <DaemonIndexBody
      loadError={null}
      loaded
      rows={[]}
      trashCount={0}
      creating={false}
      selectedWorkspace="ws-a"
      filesSource={null}
      routedFolder=""
      setRoutedFolder={vi.fn()}
      onOpenDocument={vi.fn()}
      workspacesLoaded
      workspaceCount={1}
      onCreate={vi.fn()}
      onDuplicate={vi.fn()}
      onRequestDelete={vi.fn()}
      onRetryWorkspaces={vi.fn()}
      serverMode={serverMode}
    />,
  )
  return screen.getByTestId('empty-state-subtitle').textContent
}

describe('an empty workspace names who keeps its documents', () => {
  it('a server, when a server-mode keeper serves the page', () => {
    expect(emptyWorkspace(true)).toBe('Documents live in this workspace, kept by this server.')
  })

  it('the local daemon, otherwise', () => {
    expect(emptyWorkspace(false)).toBe(
      'Documents live in this workspace, kept by your local daemon.',
    )
  })
})
