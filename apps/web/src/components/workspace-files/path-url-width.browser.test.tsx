import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { documentPathPrefix } from '../../lib/app-routes.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// A real browser, because the subject is LAYOUT and jsdom computes none.
//
// The path field draws the head of the document's URL in front of the box.
// That head is unbreakable text, and a workspace with no segment is addressed
// by its 26-character canonical id — so on the widest handle the prefix is
// most of the row. The dialog's form is a GRID item, whose automatic minimum
// size is its min-content width, so without `min-w-0` that prefix widened the
// form past the dialog's own max: measured at 464px inside a 448px dialog,
// overflowing on every viewport including a phone.

afterEach(cleanup)

// The shape that provoked it: no segment, so the handle IS the canonical id.
const ULID_HANDLE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const entry = {
  documentId: 'd1',
  path: 'design/login',
  name: 'Login flow',
  kind: 'spatial' as const,
}

async function openRenameDialog() {
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({ listDocuments: async () => [entry] })}
      workspace={ULID_HANDLE}
      onOpenDocument={() => {}}
    />,
  )
  await userEvent.click((await screen.findAllByRole('button', { name: 'Open folder design' }))[0]!)
  const card = (await screen.findAllByTestId('card-title')).find(
    (n) => n.textContent === 'Login flow',
  )
  await userEvent.click(card?.closest('button') as HTMLElement)
  await userEvent.click(await screen.findByRole('button', { name: /Rename/ }))
  return screen.findByRole('dialog')
}

describe('path field at the widest handle', () => {
  it('does not widen the dialog past its own bound', async () => {
    const dialog = await openRenameDialog()
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1)

    // The subject is PRESENT: a run where the prefix failed to render would
    // satisfy the bound above while proving nothing.
    const prefix = within(dialog).getByTitle(documentPathPrefix(ULID_HANDLE))
    expect(prefix.textContent).toBe(documentPathPrefix(ULID_HANDLE))
    expect(prefix.getBoundingClientRect().width).toBeGreaterThan(100)
  })

  it('leaves a usable box to type in', async () => {
    const dialog = await openRenameDialog()
    const input = within(dialog).getByLabelText(/^Path/) as HTMLInputElement
    // The `min-w-[10ch]` floor: past it the handle truncates instead of the
    // field being squeezed away. 10ch of this mono face measured ~84px.
    expect(input.getBoundingClientRect().width).toBeGreaterThanOrEqual(80)

    // And it still edits the path, prefix or no prefix.
    await userEvent.fill(input, 'archive/login')
    expect(input.value).toBe('archive/login')
  })
})
