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

const SEEDED = { documentId: 'd1', path: 'seed', kind: 'markdown' as const }

function renderPanel() {
  const source = fakeFilesSource({
    listDocuments: () => Promise.resolve([SEEDED]),
    // The layout toggles exist only while there ARE results, so the search
    // has to answer with one; the default empty answer removes the very
    // buttons this file is about.
    searchDocuments: async () => [{ document: SEEDED, contexts: [] }],
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
      expect(document.querySelector('button[aria-label="New document"]')).not.toBeNull()
    })
    for (const label of ['New document', 'One column', 'Two columns']) {
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
    // Search answers asynchronously now (the source reads content), so the
    // results — and the toolbar sitting above them — keep moving until they
    // land. Hovering mid-flight fails as "element is not stable", which
    // reads like a tooltip bug and is not one.
    await vi.waitFor(() => {
      expect(document.querySelector('button[aria-label="List results"]')).not.toBeNull()
      expect(document.querySelectorAll('[data-testid="result-title"]').length).toBeGreaterThan(0)
    })
    for (const label of ['List results', 'Grid results']) {
      await expectTooltip(label)
    }
  })

  it('keyboard focus reveals the name too', async () => {
    // Trusted keyboard input, never a programmatic focus(): reaching the
    // tooltip through :focus-visible is the behavior under test, and the
    // live app demonstrably does NOT open it for element.focus() — a
    // programmatic call here would pass on a UA heuristic the product
    // never relies on.
    renderPanel()
    await vi.waitFor(() => {
      expect(document.querySelector('button[aria-label="New document"]')).not.toBeNull()
    })
    const button = document.querySelector('button[aria-label="New document"]') as HTMLElement
    for (let hops = 0; hops < 12 && document.activeElement !== button; hops++) {
      await userEvent.tab()
    }
    expect(document.activeElement).toBe(button)
    await vi.waitFor(() => {
      const tips = [...document.querySelectorAll('[data-slot="tooltip-content"], [role="tooltip"]')]
      expect(tips.some((t) => t.textContent?.includes('New document'))).toBe(true)
    })
  })
})
