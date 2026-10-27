/**
 * A folder's display name over the browser keeper: real IndexedDB, the real
 * tree index, the real panel. A new subfolder holds its name only in the page
 * until a document lands in it, so what this proves is the whole hand-off —
 * the name shown at once, written once the folder holds something, and read
 * back by a fresh mount over the same store, which is what a reload is.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { ensureBrowserWorkspace } from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-folder-names')

// A cold IndexedDB fold plus the lazy panel outlasts the default find window.
const LOAD = { timeout: 10_000 }

async function seed(): Promise<FoldingBrowserIndex> {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'class/notes',
    kind: 'markdown',
    name: 'Notes',
  })
  return index
}

function mount(index: FoldingBrowserIndex, folder: string) {
  return render(
    <MemoryRouter initialEntries={[`/?folder=${folder}`]}>
      <BrowserIndexPage index={index} onOpenDocument={() => {}} />
    </MemoryRouter>,
  )
}

async function newSubfolderOf(folder: string, name: string) {
  const tree = await screen.findByRole('tree', { name: 'Workspace folders' }, LOAD)
  const row = await within(tree).findByRole('button', { name: `Open folder ${folder}` }, LOAD)
  await userEvent.click(row, { button: 'right' })
  const menu = await screen.findByRole('menu', { name: 'Folder actions' })
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'New subfolder…' }))
  const dialog = await screen.findByRole('dialog', { name: 'New subfolder' })
  await userEvent.type(within(dialog).getByLabelText('Folder name'), `${name}{Enter}`)
  return dialog
}

describe('a named folder in a browser-kept workspace', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(cleanup)

  it('keeps a new subfolder name once a note lands in it, across a fresh mount', async () => {
    const index = await seed()
    const first = mount(index, 'class')
    await newSubfolderOf('class', 'Week 6')

    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() => expect(within(trail).getByRole('button', { name: 'Week 6' })).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: 'New document' }))
    await userEvent.click(await screen.findByTestId('new-document-markdown'))
    await waitFor(
      async () =>
        expect(await index.listFolderNames({ workspaceId: getBrowserWorkspaceId() })).toEqual([
          { path: 'class/week-6', name: 'Week 6' },
        ]),
      LOAD,
    )
    first.unmount()

    mount(new FoldingBrowserIndex(), 'class')
    const tree = await screen.findByRole('tree', { name: 'Workspace folders' }, LOAD)
    expect(
      await within(tree).findByRole('button', { name: 'Open folder Week 6' }, LOAD),
    ).toBeTruthy()
  })

  it('refuses a subfolder a sibling folder already shows, beside the field', async () => {
    const index = await seed()
    await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'class/week-6/notes',
      kind: 'markdown',
    })
    await index.setFolderName({
      workspaceId: getBrowserWorkspaceId(),
      path: 'class/week-6',
      name: 'Week 6',
    })
    mount(index, 'class')
    const dialog = await newSubfolderOf('class', 'week 6')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Another folder in this folder is already called "week 6". Choose a name no other folder beside it has.',
    )
  })
})
