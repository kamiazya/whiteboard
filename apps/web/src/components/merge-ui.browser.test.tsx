import type { BranchMeta, MergeResponse } from '@kamiazya/whiteboard-mcp/api-contracts'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../index.css'
import { MERGE_COMMITTED_EVENT } from '@/lib/merge-committed-event'
import { MergeDialog } from './MergeDialog.js'
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

describe('MergeDialog layout (browser — confirm footer reachable below the fold)', () => {
  afterEach(async () => {
    // Restore the shared browser instance's default viewport so later tests
    // in this project (default 1280x900) do not inherit this test's override.
    await page.viewport(1280, 900)
  })

  it('keeps the Merge confirm button reachable at a ~1200x800 viewport', async () => {
    await page.viewport(1200, 800)

    // A wide badge set forces the merged-preview card, badge list, and
    // side-effect notice to stack tall enough that the dialog exceeds an
    // 800px-tall viewport.
    const badges = Array.from({ length: 20 }, (_, index) => ({
      type: 'field_merge',
      elementId: `el-${index}`,
      fields: ['strokeColor', 'backgroundColor'],
    }))
    const runMerge = vi.fn().mockResolvedValue({
      badges,
      preview: { elementCount: 240 },
      target: { elementCount: 200 },
      source: { elementCount: 220 },
    } satisfies MergeResponse)

    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )

    // Real click fails with "element is outside of the viewport" if the
    // footer falls below the fold and the body has no overflow-y.
    await page.getByTestId('merge-confirm-button').click()

    await waitFor(() => {
      expect(runMerge).toHaveBeenLastCalledWith('feature', { into: 'main', dryRun: false })
    })

    // The dialog renders through a portal, so query the document rather
    // than the render container.
    const scrollBody = document.querySelector('[data-slot="merge-dialog-body"]')
    expect(scrollBody).toBeInstanceOf(HTMLDivElement)
    expect(scrollBody!.scrollHeight).toBeGreaterThan(scrollBody!.clientHeight)

    const footer = document.querySelector('[data-slot="dialog-footer"]')
    expect(footer).toBeInstanceOf(HTMLDivElement)
    expect(scrollBody!.contains(footer)).toBe(false)
  })
})

describe('merge event wiring (browser — MergeDialog dispatch drives Toast)', () => {
  it('committing the merge in the dialog shows the toast', async () => {
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
          path="c1"
        />
        <MergeToast workspaceId="w1" path="c1" />
      </>,
    )

    await expect.element(page.getByTestId('merge-confirm-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('merge-confirm-button'))

    await expect.element(page.getByTestId('merge-toast')).toBeVisible()
  })

  it('a hand-crafted invalid merge_committed event produces no toast and no error', async () => {
    render(<MergeToast workspaceId="w1" path="c1" />)

    window.dispatchEvent(new CustomEvent(MERGE_COMMITTED_EVENT, { detail: { nope: true } }))

    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })
})
