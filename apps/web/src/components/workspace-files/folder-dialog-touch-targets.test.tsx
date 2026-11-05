// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// The class, not a measured box: the browser runner emulates no
// `pointer: coarse`, so the 44px floor is only ever observable as the variant
// that would apply on a touch screen.

afterEach(cleanup)

const COARSE_FLOOR = /pointer-coarse:min-h-11/

function renderPanel() {
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({
        listDocuments: async () => [
          { documentId: 'd1', path: 'notes', name: 'Notes', kind: 'markdown' },
        ],
      })}
      onOpenDocument={() => {}}
    />,
  )
}

describe('folder and rename dialogs on a touch screen', () => {
  it('gives the New folder field and both buttons a 44px floor', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    for (const control of [
      within(dialog).getByLabelText('Folder name'),
      within(dialog).getByRole('button', { name: 'Cancel' }),
      within(dialog).getByRole('button', { name: 'Create folder' }),
    ]) {
      expect(control.className).toMatch(COARSE_FLOOR)
    }
  })

  it('gives the Rename path field and both buttons a 44px floor', async () => {
    renderPanel()
    const card = (await screen.findAllByTestId('card-title'))
      .find((each) => each.textContent === 'Notes')
      ?.closest('button') as HTMLElement
    fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename' })
    for (const control of [
      within(dialog).getByLabelText(/^Path/),
      within(dialog).getByRole('button', { name: 'Cancel' }),
      within(dialog).getByRole('button', { name: 'Save' }),
    ]) {
      expect(control.className).toMatch(COARSE_FLOOR)
    }
  })
})
