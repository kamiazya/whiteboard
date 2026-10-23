// A file dropped on the document list in a REAL browser: the default drop
// navigates the tab to the file, which only a real DragEvent with a real
// DataTransfer shows being stopped.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../index.css'
import type { ImportedDocument } from '../../lib/document-import.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

function dropOn(target: Element, files: File[]): DragEvent {
  const dataTransfer = new DataTransfer()
  for (const file of files) dataTransfer.items.add(file)
  const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
  target.dispatchEvent(event)
  return event
}

function renderPanel(importDocument: (path: string, d: ImportedDocument) => Promise<void>) {
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({ listDocuments: async () => [], importDocument })}
      memoryScope="space"
    />,
  )
}

describe('dropping a file on the document list', () => {
  it('imports a canvas file and stops the browser navigating to it', async () => {
    const importDocument = vi.fn(async () => {})
    renderPanel(importDocument)
    const panel = await screen.findByTestId('workspace-files-panel')

    const file = new File(['{"nodes":[],"edges":[]}'], 'My Board.canvas', {
      type: 'application/json',
    })
    const event = dropOn(panel, [file])

    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(importDocument).toHaveBeenCalledOnce())
    expect(importDocument.mock.calls[0]).toMatchObject([
      'my-board',
      { kind: 'spatial', name: 'My Board' },
    ])
  })

  it('stops the navigation for a file it cannot import and says what is accepted', async () => {
    const importDocument = vi.fn(async () => {})
    renderPanel(importDocument)
    const panel = await screen.findByTestId('workspace-files-panel')

    const event = dropOn(panel, [new File(['x'], 'photo.png', { type: 'image/png' })])

    expect(event.defaultPrevented).toBe(true)
    expect((await screen.findByRole('alert')).textContent).toMatch(/photo\.png.*\.md.*\.canvas/)
    expect(importDocument).not.toHaveBeenCalled()
  })

  it('leaves a drag that carries no file alone', async () => {
    renderPanel(vi.fn(async () => {}))
    const panel = await screen.findByTestId('workspace-files-panel')
    const text = new DataTransfer()
    text.setData('text/plain', 'hello')
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: text })
    panel.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
