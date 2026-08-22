import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// The document browser's toolbar is icon-only; ADR-0006 point 4 says an
// icon-only control reveals its name. The grid's Radix tooltips retired
// with it — this pins their return on the panel. Real browser because
// jsdom cannot be trusted to portal-render Radix tooltip content.

// testing-library's cleanup, never a bare innerHTML wipe: React must
// unmount its own roots, or its later teardown removeChild()s nodes that
// are no longer in the document and the file fails with unhandled
// NotFoundErrors (measured on CI).
afterEach(cleanup)

function renderPanel() {
  const source = fakeFilesSource({
    listDocuments: () =>
      Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
  })
  return render(<WorkspaceFilesPanel source={source} />)
}

async function expectTooltip(label: string) {
  const button = document.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null
  if (!button) throw new Error(`no button labeled ${label}`)
  await userEvent.hover(button)
  await vi.waitFor(() => {
    const tips = [...document.querySelectorAll('[data-slot="tooltip-content"], [role="tooltip"]')]
    // The visible name matches the accessible one, so the two cannot drift.
    expect(tips.some((t) => t.textContent?.includes(label))).toBe(true)
  })
  await userEvent.unhover(button)
}

describe('document browser toolbar tooltips (real browser)', () => {
  it('every icon-only control reveals its name on hover', async () => {
    renderPanel()
    await vi.waitFor(() => {
      expect(document.querySelector('button[aria-label="New canvas"]')).not.toBeNull()
    })
    for (const label of ['New markdown document', 'New canvas', 'One column', 'Two columns']) {
      await expectTooltip(label)
    }
  })

  it('the search layout toggles reveal their names too', async () => {
    const { rerender: _r } = renderPanel()
    await vi.waitFor(() => {
      expect(document.querySelector('input[aria-label="Search documents"]')).not.toBeNull()
    })
    const search = document.querySelector(
      'input[aria-label="Search documents"]',
    ) as HTMLInputElement
    search.focus()
    await userEvent.fill(search, 'seed')
    await vi.waitFor(() => {
      expect(document.querySelector('button[aria-label="List results"]')).not.toBeNull()
    })
    for (const label of ['List results', 'Grid results']) {
      await expectTooltip(label)
    }
  })

  it('keyboard focus reveals the name too', async () => {
    renderPanel()
    await vi.waitFor(() => {
      expect(document.querySelector('button[aria-label="New canvas"]')).not.toBeNull()
    })
    const button = document.querySelector('button[aria-label="New canvas"]') as HTMLElement
    button.focus()
    await vi.waitFor(() => {
      const tips = [...document.querySelectorAll('[data-slot="tooltip-content"], [role="tooltip"]')]
      expect(tips.some((t) => t.textContent?.includes('New canvas'))).toBe(true)
    })
  })
})
