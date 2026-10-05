/**
 * The open note deleted somewhere else — another tab's list, an agent. The
 * delete is written to the record by the index and announced by path; the
 * page holding the note has to stop taking edits and say why, or it reads
 * every keystroke after the delete as saved while none of them is kept.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { IdbDefaultDocumentPointer } from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderInRouter } from '../test-utils/daemon-page-harness.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'

claimIsolatedWhiteboardDb('browserdocumentpage-deleted-elsewhere')

const WAIT = { timeout: 10_000 }

function editorIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.cm-content[contenteditable="true"]')
}

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(async () => {
  cleanup()
  await clearWhiteboardDb()
})

function persistStateOf(container: HTMLElement): string | null | undefined {
  return container
    .querySelector('[data-testid="persistence-state"]')
    ?.getAttribute('data-save-state')
}

/**
 * A note open on the page, with a line typed into it and saved. Created in
 * the workspace tree, the way the app creates one, so the trash holds what
 * the delete took.
 */
async function openSavedNote() {
  const store = new FoldingBrowserIndex()
  const workspaceId = getBrowserWorkspaceId()
  await store.createWorkspace({ workspaceId })
  const { documentId } = await store.createDocument({ workspaceId, path: 'note', kind: 'markdown' })
  await new IdbDefaultDocumentPointer().set(documentId)
  const page = renderInRouter(<BrowserDocumentPage store={store} />, { height: '50vh' })
  await focusEditable(() => editorIn(page.container))
  await userEvent.keyboard('# Before the delete')
  await waitFor(() => expect(persistStateOf(page.container)).toBe('saved'), WAIT)
  return { page, documentId }
}

/**
 * The comments rail beside the note, with a document comment being composed —
 * the write surface outside the editor that a delete has to lock as well.
 */
async function composeDocumentComment(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /^Comments/ }, WAIT))
  await userEvent.click(await screen.findByRole('button', { name: 'Comment on the document' }))
  await waitFor(() => expect(sendCommentButton()).not.toBeNull(), WAIT)
}

/** Read from the DOM, not by role: an inert subtree is outside the accessibility tree. */
function sendCommentButton(): HTMLElement | null {
  return document.querySelector('button[aria-label="Send comment"]')
}

function titleField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Title')
}

async function deleteElsewhere(): Promise<void> {
  await new FoldingBrowserIndex().deleteDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'note',
  })
}

it('a note deleted elsewhere says so and stops taking edits', async () => {
  const { page } = await openSavedNote()
  await composeDocumentComment()
  expect(sendCommentButton()?.closest('[inert]')).toBeNull()
  expect(titleField().readOnly).toBe(false)

  await deleteElsewhere()

  const notice = await screen.findByTestId('document-removed-notice', undefined, WAIT)
  expect(notice.textContent).toContain('deleted elsewhere')
  expect(
    within(screen.getByTestId('restore-status')).getByRole('button', { name: 'Back to documents' }),
  ).toBeTruthy()
  await waitFor(() => expect(editorIn(page.container)?.closest('[inert]')).not.toBeNull(), WAIT)
  // What was on screen stays readable; only writing it stops.
  expect(editorIn(page.container)?.textContent).toBe('# Before the delete')
  // Beside the editor too: a comment sent now would be cleared from its box
  // and dropped by a session that no longer writes, and so would a rename.
  expect(sendCommentButton()?.closest('[inert]')).not.toBeNull()
  expect(titleField().readOnly).toBe(true)
  // The menu keeps what only reads the note and drops what would write it.
  await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
  await screen.findByRole('menuitem', { name: /Export/ })
  expect(screen.queryByRole('menuitem', { name: /Bookmark/ })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
  await userEvent.keyboard('{Escape}')
})

it('a note restored from the trash elsewhere is editable again, and saves', async () => {
  const { page, documentId } = await openSavedNote()
  await composeDocumentComment()
  await deleteElsewhere()
  await screen.findByTestId('document-removed-notice', undefined, WAIT)
  await waitFor(() => expect(sendCommentButton()?.closest('[inert]')).not.toBeNull(), WAIT)

  await new FoldingBrowserIndex().restoreDocument({
    workspaceId: getBrowserWorkspaceId(),
    documentId,
  })

  await waitFor(() => expect(screen.queryByTestId('document-removed-notice')).toBeNull(), WAIT)
  expect(editorIn(page.container)?.closest('[inert]')).toBeNull()
  expect(sendCommentButton()?.closest('[inert]')).toBeNull()
  expect(titleField().readOnly).toBe(false)
  await focusEditable(() => editorIn(page.container))
  await userEvent.keyboard('{Control>}{End}{/Control} again')
  await waitFor(
    () => expect(editorIn(page.container)?.textContent).toBe('# Before the delete again'),
    WAIT,
  )
  await waitFor(() => expect(persistStateOf(page.container)).toBe('saved'), WAIT)
})
