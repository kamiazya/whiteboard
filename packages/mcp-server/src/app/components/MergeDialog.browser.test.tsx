import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../index.css'
import type { BranchMeta, MergeResult } from '../hooks/useBranches.js'
import { MergeDialog } from './MergeDialog.js'

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

// A wide badge set forces the merged-preview card, badge list, and side-effect
// notice to stack tall enough that the dialog exceeds an 800px-tall viewport.
function tallMergeResult(): MergeResult {
  const badges = Array.from({ length: 20 }, (_, index) => ({
    type: 'field_merge',
    elementId: `el-${index}`,
    fields: ['strokeColor', 'backgroundColor'],
  }))
  return {
    badges,
    preview: { elementCount: 240 },
    target: { elementCount: 200 },
    source: { elementCount: 220 },
  }
}

afterEach(async () => {
  cleanup()
  // Restore the shared browser instance's default viewport so later tests
  // in this project (default 1280x900) do not inherit this test's override.
  await page.viewport(1280, 900)
})

describe('MergeDialog browser mode', () => {
  it('keeps the Merge confirm button reachable at a ~1200x800 viewport', async () => {
    await page.viewport(1200, 800)

    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockResolvedValue(tallMergeResult())
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

    await vi.waitFor(() => {
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
