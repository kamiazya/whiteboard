// The panel hands ONE broker to a row's thumbnail and to the preview pane
// beside it, so two panes showing the same document cost one trip through the
// pipeline (ADR-0027).
//
// A real browser rather than jsdom, and not for layout: the pipeline has to
// SUCCEED for the memo to hold anything. In jsdom the worker pool is absent,
// the render rejects, and a rejection is deliberately not memoised — so both
// panes retry and the count is 2 for a reason that has nothing to do with the
// broker. The premise this test needs is a working renderer.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

it('draws a document once, however many panes show it', async () => {
  const entry = {
    documentId: 'd1',
    path: 'note',
    kind: 'markdown' as const,
    updatedAt: '2026-09-03T00:00:00Z',
  }
  const loadMarkdown = vi.fn(async () => '# Hello\n\nsome body to give it a shape')
  const source = fakeFilesSource({ listDocuments: async () => [entry], loadMarkdown })

  render(<WorkspaceFilesPanel source={source} />)

  // The row's own thumbnail, drawn by the real renderer. `data-kind` marks
  // the PLACEHOLDER icon, which is itself an <svg> — so its absence, not the
  // presence of an svg, is what says the render landed.
  const card = (await screen.findAllByTestId('card-title'))[0] as HTMLElement
  const thumbnail = () => document.querySelector('[data-testid="document-thumbnail"]')
  await waitFor(() => expect(thumbnail()?.querySelector('[data-kind]')).toBeNull(), {
    timeout: 15_000,
  })
  expect(loadMarkdown).toHaveBeenCalledTimes(1)

  // Selecting opens the preview pane over the document the row already drew.
  await userEvent.click(card.closest('button') ?? card)
  await waitFor(
    () => expect(document.querySelector('[data-testid="preview-render"] svg')).not.toBeNull(),
    { timeout: 15_000 },
  )

  expect(loadMarkdown).toHaveBeenCalledTimes(1)
})
