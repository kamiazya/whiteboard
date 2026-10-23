// A board's own tags (ADR-0040 decision 2) reach the document list the way a
// note's frontmatter tags do: the row's chip, the vocabulary strip and the
// `#tag` filter — read from a browser-kept workspace's real storage.
import { writeCoreFacets, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { createBrowserFilesSource } from '../../lib/browser-files-source.js'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { LoroStore } from '../../lib/loro-store.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../../test-utils/seed-legacy-row.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

claimIsolatedWhiteboardDb('board-tags-list')
beforeEach(clearWhiteboardDb)
afterEach(cleanup)

it('shows a board’s own tag on its row and filters the list by it', async () => {
  const workspaceId = getBrowserWorkspaceId()
  const store = new LoroStore()
  const board = await seedLegacyRow({ workspaceId, path: 'floor-plan', kind: 'spatial' })
  const note = await seedLegacyRow({ workspaceId, path: 'groceries', kind: 'markdown' })
  const boardDoc = new Loro()
  writeSpatialCanvas(boardDoc, { nodes: [], edges: [], tags: ['home'] })
  await store.save(board.documentId, boardDoc.export({ mode: 'snapshot' }))
  const noteDoc = new Loro()
  writeCoreFacets(noteDoc, { type: 'note' })
  await store.save(note.documentId, noteDoc.export({ mode: 'snapshot' }))

  render(<WorkspaceFilesPanel source={createBrowserFilesSource()} />)

  const chip = await screen.findByRole('button', { name: '#home' })
  // The strip's button and the board's own row both carry it.
  expect(screen.getAllByText('#home').length).toBeGreaterThanOrEqual(2)

  await userEvent.click(chip)
  await waitFor(() => expect(screen.queryByText('groceries')).toBeNull())
  expect(screen.getAllByText('floor-plan').length).toBeGreaterThan(0)
})
