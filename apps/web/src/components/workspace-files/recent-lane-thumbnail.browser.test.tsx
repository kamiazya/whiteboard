// The Recent tile draws the same picture the card draws, in a real browser:
// the render pipeline has to succeed for either to leave the kind icon.
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { STORAGE_KEY } from '../../lib/recent-documents.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const listed = [
  {
    documentId: 'd1',
    path: 'meeting-notes',
    name: 'Meeting notes',
    kind: 'markdown' as const,
    updatedAt: '2026-09-03T00:00:00Z',
    contentDigest: 'c0ffee0000000001',
  },
  ...Array.from({ length: 10 }, (_, i) => ({
    documentId: `f${i}`,
    path: `filler-${i}`,
    name: `Filler ${i}`,
    kind: 'markdown' as const,
    updatedAt: '2026-09-03T00:00:00Z',
    contentDigest: `c0ffee00000001${String(i).padStart(2, '0')}`,
  })),
]

beforeEach(() => localStorage.removeItem(STORAGE_KEY))
afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
})

function boardSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 220, height: 120, text: 'first node' }),
      textNode({ id: 'b', x: 400, y: 220, width: 220, height: 120, text: 'second node' }),
    ],
    edges: [],
  })
  return doc.export({ mode: 'snapshot' })
}

function renderPanel(documents: typeof listed = listed) {
  const source = fakeFilesSource({
    listDocuments: async () => documents,
    loadMarkdown: async () => ({ body: '# Hello\n\nsome body to give it a shape' }),
    loadSpatialSnapshot: async () => boardSnapshot(),
  })
  render(<WorkspaceFilesPanel source={source} memoryScope="space" onOpenDocument={() => {}} />)
}

async function recentTilePicture(documents: typeof listed, title: string) {
  renderPanel(documents)
  await screen.findByTestId('folder-contents')
  const cards = await screen.findAllByText(title)
  await userEvent.dblClick((cards[0] as HTMLElement).closest('button') as HTMLElement)
  cleanup()

  renderPanel(documents)
  const lane = await screen.findByTestId('recent-lane')
  const picture = () => lane.querySelector('[data-testid="document-thumbnail"]')
  await waitFor(() => expect(picture()).not.toBeNull())
  await waitFor(
    () => {
      expect(picture()?.querySelector('[data-kind]')).toBeNull()
      expect(picture()?.querySelector('svg')).not.toBeNull()
      const box = picture()?.querySelector('svg')?.getBoundingClientRect()
      expect(box?.width).toBeGreaterThan(40)
      expect(box?.height).toBeGreaterThan(20)
    },
    { timeout: 15_000 },
  )
}

const board = (over: Partial<(typeof listed)[number]>) => ({
  documentId: 'b1',
  path: 'board',
  name: 'Board',
  kind: 'spatial' as unknown as 'markdown',
  updatedAt: '2026-09-03T00:00:00Z',
  contentDigest: 'c0ffee0000000009',
  ...over,
})

it('draws a note in the Recent tile', async () => {
  await recentTilePicture(listed, 'Meeting notes')
})

it('draws a populated board in the Recent tile', async () => {
  await recentTilePicture([board({}), ...listed.slice(1)], 'Board')
})

it('draws a board whose listing row carries no content digest yet', async () => {
  const { contentDigest: _unknown, ...undigested } = board({})
  await recentTilePicture([undigested as ReturnType<typeof board>, ...listed.slice(1)], 'Board')
})
