/**
 * Two pages open on one browser-kept note, standing for two tabs: each mounts
 * its own backend, and BroadcastChannel delivers between channel objects in
 * one realm exactly as it does between tabs.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import '../index.css'

claimIsolatedWhiteboardDb('browserdocumentpage-cross-tab')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '50vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

/** The source editor inside the page mounted in `container`. */
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

it('a line typed on one page shows up on the other page open on the note', async () => {
  const store = new IdbDocumentIndex()
  await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
  const tabA = render(<BrowserDocumentPage store={store} />)
  const tabB = render(<BrowserDocumentPage store={store} />)
  await waitFor(() => expect(editorIn(tabB.container)).not.toBeNull(), { timeout: 10_000 })

  await focusEditable(() => editorIn(tabA.container))
  await userEvent.keyboard('# From tab A')

  await waitFor(() => expect(editorIn(tabB.container)?.textContent).toBe('# From tab A'), {
    timeout: 10_000,
  })
})
