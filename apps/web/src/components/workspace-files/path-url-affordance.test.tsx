// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { documentPathPrefix } from '../../lib/app-routes.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// A path is not a loose string: it is the tail of the document's URL, one
// URL segment per path segment. Both forms that edit one draw the head of
// that URL in front of the box, the way the workspace switcher draws `/w/`
// in front of a segment — so the field shows where the text lands instead of
// requiring somebody to already know.
//
// The prefix is READ from the router's own builder. A literal written out
// here, or in the component, would keep reading right long after the grammar
// moved, which is the whole reason `documentPathPrefix` is exported.

afterEach(cleanup)

const WORKSPACE = 'design-team'

const entry = {
  documentId: 'd1',
  path: 'design/login',
  name: 'Login flow',
  kind: 'spatial' as const,
}

// No default parameter: `renderPanel(undefined)` would then silently re-supply
// the handle, and the unknown-workspace case below would assert against a
// fixture that never reached it.
function renderPanel(workspace: string | undefined) {
  const source = fakeFilesSource({ listDocuments: async () => [entry] })
  render(<WorkspaceFilesPanel source={source} workspace={workspace} onOpenDocument={() => {}} />)
  return source
}

async function openFolder() {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Open folder design' }))[0]!)
  await waitFor(() => {
    expect(
      screen.queryAllByTestId('card-title').some((el) => el.textContent === 'Login flow'),
    ).toBe(true)
  })
}

async function openRenameDialog() {
  await openFolder()
  const card = screen.getAllByTestId('card-title').find((n) => n.textContent === 'Login flow')
  fireEvent.click(card?.closest('button') as HTMLElement)
  fireEvent.click(await screen.findByRole('button', { name: /Rename/ }))
  return screen.findByRole('dialog')
}

async function openNewDocumentDialog() {
  await openFolder()
  // Radix's DropdownMenuTrigger opens on pointerDown, not click.
  fireEvent.pointerDown(screen.getByRole('button', { name: /new document/i }), { button: 0 })
  fireEvent.click(await screen.findByRole('menuitem', { name: /Name and folder/ }))
  return screen.findByRole('dialog')
}

// The prefix is three spans, not one — a segment-less workspace is addressed
// by a 26-character id, and only the handle is allowed to truncate so that
// `/w/` and `/d/` stay legible. So it is found by the `title` that carries the
// untruncated value, and its rendered text is asserted separately: `getByText`
// reads only an element's DIRECT text children and would see nothing here.
function prefixOf(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByTitle(documentPathPrefix(WORKSPACE))
}

describe('the path field shows where in the URL its text lands', () => {
  it('draws the real URL head in front of the rename form’s path box', async () => {
    renderPanel(WORKSPACE)
    const dialog = await openRenameDialog()
    expect(prefixOf(dialog).textContent).toBe(documentPathPrefix(WORKSPACE))
  })

  it('draws it in front of the create form’s path box too', async () => {
    renderPanel(WORKSPACE)
    const dialog = await openNewDocumentDialog()
    expect(prefixOf(dialog).textContent).toBe(documentPathPrefix(WORKSPACE))
  })

  // Not decoration a screen reader is told to skip: the prefix is the only
  // thing on the form that says the path is an address, so it is part of the
  // field's own description rather than an aria-hidden flourish.
  it('names the prefix in the path field’s accessible description', async () => {
    renderPanel(WORKSPACE)
    const dialog = await openRenameDialog()
    const input = within(dialog).getByLabelText(/^Path/)
    const described = (input.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    expect(described).toContain(documentPathPrefix(WORKSPACE))
    expect(described).toContain('Where it lives in the workspace')
  })

  // The panel is rendered before its page knows the handle, and on a page
  // that has none at all. Half a URL is worse than none: `/w//d/` reads as a
  // real address and is not one.
  it('shows no URL head at all when the workspace is not known yet', async () => {
    renderPanel(undefined)
    const dialog = await openRenameDialog()
    expect(within(dialog).queryByTitle(/^\/w\//)).toBeNull()
    expect(dialog.textContent ?? '').not.toContain('/w/')
    // The field itself is unaffected — it still edits the same path.
    expect((within(dialog).getByLabelText(/^Path/) as HTMLInputElement).value).toBe('design/login')
  })
})
