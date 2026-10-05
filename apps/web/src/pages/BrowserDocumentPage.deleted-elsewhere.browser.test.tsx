/**
 * The open note deleted somewhere else — another tab's list, an agent. The
 * delete is written to the record by the index and announced by path; the
 * page holding the note has to stop taking edits and say why, or it reads
 * every keystroke after the delete as saved while none of them is kept.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderInRouter } from '../test-utils/daemon-page-harness.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
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

it('a note deleted elsewhere says so and stops taking edits', async () => {
  const store = new IdbDocumentIndex()
  await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
  const page = renderInRouter(<BrowserDocumentPage store={store} />, { height: '50vh' })
  await focusEditable(() => editorIn(page.container))
  await userEvent.keyboard('# Before the delete')
  await waitFor(
    () =>
      expect(
        page.container
          .querySelector('[data-testid="persistence-state"]')
          ?.getAttribute('data-save-state'),
      ).toBe('saved'),
    WAIT,
  )

  await new FoldingBrowserIndex().deleteDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'note',
  })

  const notice = await screen.findByTestId('document-removed-notice', undefined, WAIT)
  expect(notice.textContent).toContain('deleted elsewhere')
  expect(
    within(screen.getByTestId('restore-status')).getByRole('button', { name: 'Back to documents' }),
  ).toBeTruthy()
  await waitFor(() => expect(editorIn(page.container)?.closest('[inert]')).not.toBeNull(), WAIT)
  // What was on screen stays readable; only writing it stops.
  expect(editorIn(page.container)?.textContent).toBe('# Before the delete')
})
