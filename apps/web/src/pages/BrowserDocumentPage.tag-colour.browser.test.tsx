/**
 * Colouring a tag from its chip in the Display panel writes the workspace's
 * tag library (ADR-0040 decision 5), so an uncoloured box carrying that tag is
 * drawn in the colour and the legend lists the key. Real IndexedDB, the real
 * keeper source and the real editor: the write, the re-read and the redraw
 * are the wiring this pins.
 */
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { LoroStore } from '../lib/loro-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import { setViewport } from '../test-utils/viewport.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'

claimIsolatedWhiteboardDb('browserdocumentpage-tag-colour')

beforeEach(async () => {
  await clearWhiteboardDb()
  await setViewport(1280, 800)
})
afterEach(cleanup)

const boxFill = () =>
  document.querySelector('svg g[data-wb-key="svc"] rect')?.getAttribute('fill') ?? null

it('colours a tag from its chip, so the box carrying it is drawn in it and the legend lists the key', async () => {
  const id = await seedIdbDocument({ path: 'board', name: 'Board', makeDefault: true })
  const doc = new Loro()
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({
        id: 'svc',
        x: 80,
        y: 80,
        width: 200,
        height: 100,
        text: 'API',
        tags: ['tier:service'],
      }),
      textNode({
        id: 'db',
        x: 400,
        y: 80,
        width: 200,
        height: 100,
        text: 'DB',
        tags: ['tier:database'],
      }),
    ],
    edges: [],
  })
  await new LoroStore().save(id, doc.export({ mode: 'snapshot' }))
  renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)

  await waitFor(() => expect(boxFill()).not.toBeNull(), { timeout: 15_000 })
  const before = boxFill()
  expect(document.querySelector('[data-testid="legend-overlay"]')).toBeNull()

  await userEvent.click(await screen.findByRole('button', { name: /^display$/i }))
  const panel = await screen.findByTestId('display-panel', undefined, { timeout: 15_000 })
  const add = panel.querySelector('input[aria-label="Add tag"]') as HTMLInputElement
  await userEvent.type(add, 'tier:service{Enter}')

  await userEvent.click(await screen.findByRole('button', { name: 'Tag tier:service menu' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Set colour…' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Cyan' }))

  await waitFor(() => expect(boxFill()).not.toBe(before), { timeout: 15_000 })
  await waitFor(
    () => {
      const legend = document.querySelector('[data-testid="legend-overlay"]')
      expect(legend?.textContent).toContain('tier')
      expect(legend?.textContent).toContain('service')
    },
    { timeout: 15_000 },
  )
})
