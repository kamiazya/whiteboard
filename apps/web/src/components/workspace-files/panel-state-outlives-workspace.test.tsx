// @vitest-environment jsdom
/**
 * State the panel holds ABOUT A DOCUMENT must not outlive the workspace that
 * document belongs to.
 *
 * The panel already keeps this rule against a background refresh: the
 * `revision` effect re-resolves `selected` and `cardMenu` from the fresh list
 * and drops what is gone. A workspace SWITCH is the same hazard one level up
 * and was not covered — the switch effect clears `selected` and nothing else,
 * so a captured `WorkspaceDocumentEntry` survives it while `source` becomes
 * the new workspace's.
 *
 * That combination is not inert. `submitRename` closes over the CURRENT
 * source and is handed the CAPTURED entry, so it addresses the old
 * workspace's path into the new workspace's store. Paths are per-workspace
 * and collide freely — `untitled` exists in most of them — so the write
 * lands on whatever happens to sit at that path here.
 *
 * A modal does not make this unreachable: ADR-0019 makes a workspace switch
 * an in-SPA route change, and browser Back is not blocked by a Radix dialog.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

// The same path in both workspaces, which is the ordinary case rather than a
// contrived one: every workspace's first document is `untitled`.
const IN_FIRST = [
  { documentId: 'a1', path: 'untitled', name: 'Quarterly plan', kind: 'markdown' as const },
]
const IN_SECOND = [
  { documentId: 'b1', path: 'untitled', name: 'Someone else’s notes', kind: 'markdown' as const },
]

async function cardTitled(title: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getAllByTestId('card-title').some((el) => el.textContent === title)).toBe(true)
  })
  const el = screen.getAllByTestId('card-title').find((n) => n.textContent === title)
  return el?.closest('button') as HTMLElement
}

describe('panel state does not outlive its workspace', () => {
  it('a rename dialog left open across a workspace switch cannot write into the new workspace', async () => {
    const first = fakeFilesSource({ listDocuments: () => Promise.resolve(IN_FIRST) })
    const second = fakeFilesSource({ listDocuments: () => Promise.resolve(IN_SECOND) })

    const { rerender } = render(<WorkspaceFilesPanel source={first} />)

    fireEvent.contextMenu(await cardTitled('Quarterly plan'), { clientX: 20, clientY: 20 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText(/^Path/) as HTMLInputElement).value).toBe('untitled')

    // The switch: same panel, different workspace. Browser Back does this
    // with the dialog still open.
    rerender(<WorkspaceFilesPanel source={second} />)
    await waitFor(() => expect(second.listDocuments).toHaveBeenCalled())

    // Whatever the dialog does now, it must not be a write addressed at the
    // workspace on screen using the one that left.
    const stillOpen = screen.queryByRole('dialog')
    if (stillOpen !== null) {
      fireEvent.change(within(stillOpen).getByLabelText(/^Name/), {
        target: { value: 'Renamed while away' },
      })
      fireEvent.click(within(stillOpen).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(second.setDocumentName).not.toHaveBeenCalled())
    }
    expect(
      second.setDocumentName,
      'the rename was addressed into the workspace that is now on screen, using an entry from the one that left — `untitled` exists in both, so this renames a document nobody asked about',
    ).not.toHaveBeenCalled()
    expect(second.renameDocumentPath).not.toHaveBeenCalled()
  })

  it('a card menu left open across a workspace switch offers no verbs for the departed document', async () => {
    const first = fakeFilesSource({ listDocuments: () => Promise.resolve(IN_FIRST) })
    const second = fakeFilesSource({ listDocuments: () => Promise.resolve(IN_SECOND) })

    const { rerender } = render(<WorkspaceFilesPanel source={first} />)
    fireEvent.contextMenu(await cardTitled('Quarterly plan'), { clientX: 20, clientY: 20 })
    await screen.findByRole('menu', { name: 'Document actions' })

    rerender(<WorkspaceFilesPanel source={second} />)
    await waitFor(() => expect(second.listDocuments).toHaveBeenCalled())

    await waitFor(() =>
      expect(
        screen.queryByRole('menu', { name: 'Document actions' }),
        'the menu still names the departed workspace’s document, and every verb on it would act on the workspace now on screen',
      ).toBeNull(),
    )
  })
})
