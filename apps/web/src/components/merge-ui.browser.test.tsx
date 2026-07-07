import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BranchMeta, MergeResponse } from '@kamiazya/whiteboard-mcp/api-contracts'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MERGE_COMMITTED_EVENT } from '@/lib/merge-committed-event'
import { MergeDialog } from './MergeDialog.js'
import { MergeHighlight } from './MergeHighlight.js'
import { MergeToast } from './MergeToast.js'

const main: BranchMeta = {
  name: 'main',
  tipFrontiers: '',
  color: '#1971c2',
  createdAt: '2026-04-23T00:00:00Z',
}
const feature: BranchMeta = {
  name: 'feature',
  tipFrontiers: 'AAECAw==',
  color: '#9333ea',
  createdAt: '2026-04-23T01:00:00Z',
}

function stubApi(elements: ExcalidrawElement[]): ExcalidrawImperativeAPI {
  return {
    getSceneElements: () => elements,
    getAppState: () => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } }),
  } as unknown as ExcalidrawImperativeAPI
}

function makeElement(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): ExcalidrawElement {
  return { id, x, y, width, height } as unknown as ExcalidrawElement
}

beforeEach(() => {
  // MergeDialog's thumbnail-fallback effect calls apiFetch(.../versions); return
  // an empty (but schema-valid) list so it resolves without a preview image.
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ versions: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MergeDialog (browser — real Radix Dialog)', () => {
  it('opens as a real dialog, disables confirm until preview resolves, and closes on Escape', async () => {
    let resolvePreview: ((value: MergeResponse) => void) | undefined
    const runMerge = vi.fn().mockImplementation(
      () =>
        new Promise<MergeResponse>((resolve) => {
          resolvePreview = resolve
        }),
    )
    const onClose = vi.fn()
    render(
      <MergeDialog open source={feature} target={main} onClose={onClose} runMerge={runMerge} />,
    )

    await expect.element(page.getByRole('dialog')).toBeVisible()
    const confirmButton = screen.getByTestId('merge-confirm-button')
    expect(confirmButton).toBeDisabled()

    resolvePreview?.({ badges: [], preview: { elementCount: 3 } })
    await waitFor(() => expect(confirmButton).not.toBeDisabled())

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('merge event wiring (browser — MergeDialog dispatch drives Toast + Highlight)', () => {
  it('committing the merge in the dialog shows the toast and highlights the affected elements', async () => {
    const apiRef = {
      current: stubApi([
        makeElement('new-1', 10, 20, 30, 40),
        makeElement('conflict-1', 1, 2, 3, 4),
      ]),
    }
    const runMerge = vi
      .fn()
      .mockResolvedValueOnce({ badges: [], preview: { elementCount: 5 } } satisfies MergeResponse)
      .mockResolvedValueOnce({
        badges: [],
        committed: { elementCount: 5 },
        newElementIds: ['new-1'],
        conflictElementIds: ['conflict-1'],
        preMergeVersionId: 'v-pre',
      } satisfies MergeResponse)
    const onClose = vi.fn()

    render(
      <>
        <MergeDialog
          open
          source={feature}
          target={main}
          onClose={onClose}
          runMerge={runMerge}
          workspaceId="w1"
          slug="c1"
        />
        <MergeToast workspaceId="w1" slug="c1" />
        <MergeHighlight workspaceId="w1" slug="c1" apiRef={apiRef} />
      </>,
    )

    await expect.element(page.getByTestId('merge-confirm-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('merge-confirm-button'))

    await expect.element(page.getByTestId('merge-toast')).toBeVisible()
    await expect.element(page.getByTestId('merge-highlight-new')).toBeVisible()
    await expect.element(page.getByTestId('merge-highlight-conflict')).toBeVisible()
  })

  it('a hand-crafted invalid merge_committed event produces no toast, no highlight, and no error', async () => {
    const apiRef = { current: stubApi([makeElement('a', 0, 0, 1, 1)]) }
    render(
      <>
        <MergeToast workspaceId="w1" slug="c1" />
        <MergeHighlight workspaceId="w1" slug="c1" apiRef={apiRef} />
      </>,
    )

    window.dispatchEvent(new CustomEvent(MERGE_COMMITTED_EVENT, { detail: { nope: true } }))

    expect(screen.queryByTestId('merge-toast')).toBeNull()
    expect(screen.queryByTestId('merge-highlight-layer')).toBeNull()
  })
})
