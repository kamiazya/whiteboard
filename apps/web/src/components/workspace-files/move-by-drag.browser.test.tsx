// Moving a document into a folder in a REAL browser, on a browser-kept
// workspace (real IndexedDB, the production index): the drag carries a real
// DataTransfer between the card and the folder, and the keyboard path walks
// the picker with real key events. The move is the keeper's own subtree
// path move, so the document id surviving it is read back from the store.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import { ensureBrowserWorkspace } from '../../lib/browser-document-summary.js'
import { createBrowserFilesSource } from '../../lib/browser-files-source.js'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

claimIsolatedWhiteboardDb('move-by-drag')

afterEach(cleanup)
beforeEach(async () => {
  await clearWhiteboardDb()
})

async function seedAndRender() {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const ids: Record<string, string> = {}
  for (const path of ['notes', 'design/login', 'archive/old']) {
    ids[path] = (await index.createDocument({ workspaceId, path, kind: 'markdown' })).documentId
  }
  const source = createBrowserFilesSource({ index })
  render(<WorkspaceFilesPanel source={source} memoryScope="move" onOpenDocument={() => {}} />)
  await screen.findByTestId('folder-contents')
  return { source, ids }
}

const pathsOf = async (source: ReturnType<typeof createBrowserFilesSource>) =>
  Object.fromEntries((await source.listDocuments()).map((row) => [row.documentId, row.path]))

const notesCard = () =>
  within(screen.getByTestId('folder-contents'))
    .getAllByTestId('card-title')
    .find((each) => each.textContent === 'notes')
    ?.closest('button') as HTMLElement

function drag(from: Element, to: Element) {
  const dataTransfer = new DataTransfer()
  const fire = (target: Element, type: string) =>
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
  fire(from, 'dragstart')
  fire(to, 'dragenter')
  const over = fire(to, 'dragover')
  return {
    over,
    drop: () => {
      fire(to, 'drop')
      fire(from, 'dragend')
    },
  }
}

describe('dragging a document onto a folder', () => {
  it('moves it into a folder card, keeping its id, and says so', async () => {
    const { source, ids } = await seedAndRender()
    const folder = within(screen.getByTestId('folder-contents')).getByRole('button', {
      name: 'Open folder design',
    })

    const gesture = drag(notesCard(), folder)
    await waitFor(() => expect(folder.hasAttribute('data-dropping')).toBe(true))
    gesture.drop()

    await waitFor(async () =>
      expect((await pathsOf(source))[ids.notes as string]).toBe('design/notes'),
    )
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((each) => each.textContent)).toContain(
        'Moved notes to design',
      ),
    )
    expect(folder.hasAttribute('data-dropping')).toBe(false)
  })

  it('moves it into a folder in the tree beside the list', async () => {
    const { source, ids } = await seedAndRender()
    const treeFolder = within(screen.getByRole('tree', { name: 'Workspace folders' })).getByRole(
      'button',
      { name: 'Open folder archive' },
    )

    drag(notesCard(), treeFolder).drop()

    await waitFor(async () =>
      expect((await pathsOf(source))[ids.notes as string]).toBe('archive/notes'),
    )
  })

  it('leaves a document alone when it is dropped where it already is', async () => {
    const { source, ids } = await seedAndRender()
    const root = within(screen.getByRole('tree', { name: 'Workspace folders' })).getByRole(
      'button',
      { name: 'Open folder Workspace' },
    )

    drag(notesCard(), root).drop()

    await expect.poll(async () => (await pathsOf(source))[ids.notes as string]).toBe('notes')
  })
})

describe('moving a document from the keyboard', () => {
  it('opens the card menu, picks Move to folder…, arrows to a folder and Enters', async () => {
    const { source, ids } = await seedAndRender()
    notesCard().focus()

    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    within(menu).getByRole('menuitem', { name: 'Move to folder…' }).focus()
    await userEvent.keyboard('{Enter}')

    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' })
    const options = within(dialog).getAllByRole('option')
    expect(options.map((each) => each.textContent)).toEqual(['archive', 'design', 'New folder…'])
    await waitFor(() => expect(document.activeElement).toBe(options[0]))
    await userEvent.keyboard('{ArrowDown}{Enter}')

    await waitFor(async () =>
      expect((await pathsOf(source))[ids.notes as string]).toBe('design/notes'),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('cancels with Escape and moves nothing', async () => {
    const { source, ids } = await seedAndRender()
    notesCard().focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    within(menu).getByRole('menuitem', { name: 'Move to folder…' }).focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Move to folder' })

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await pathsOf(source))[ids.notes as string]).toBe('notes')
  })
})

describe('renaming a folder from its menu', () => {
  it('changes only what it is called: nothing under it moves', async () => {
    const { source, ids } = await seedAndRender()
    const folder = within(screen.getByTestId('folder-contents')).getByRole('button', {
      name: 'Open folder design',
    })
    folder.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    )
    const menu = await screen.findByRole('menu', { name: 'Folder actions' })
    within(menu).getByRole('menuitem', { name: 'Rename…' }).focus()
    await userEvent.keyboard('{Enter}')

    const dialog = await screen.findByRole('dialog', { name: 'Rename folder' })
    await userEvent.fill(within(dialog).getByLabelText('Folder name'), 'Plans')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(
      await within(screen.getByTestId('folder-contents')).findByRole('button', {
        name: 'Open folder Plans',
      }),
    ).toBeTruthy()
    expect(await source.listFolderNames?.()).toEqual([{ path: 'design', name: 'Plans' }])
    expect((await pathsOf(source))[ids['design/login'] as string]).toBe('design/login')
  })
})
