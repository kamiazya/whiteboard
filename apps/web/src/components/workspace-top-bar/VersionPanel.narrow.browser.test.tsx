import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { VersionPanel } from './VersionPanel.js'

type FetchArgs = [RequestInfo | URL, RequestInit?]

function mkVersionsResponse(): Response {
  const versions = Array.from({ length: 12 }, (_, index) => ({
    id: `v-${index}`,
    path: 'canvas-a',
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    elementCount: 3,
    label: `Version ${index + 1}`,
    auto: true,
    hasThumbnail: false,
    branchName: 'main',
  }))
  return new Response(JSON.stringify({ versions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/branches')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            head: 'main',
            branches: [
              {
                name: 'main',
                tipFrontiers: '',
                color: '#1971c2',
                createdAt: '2026-04-23T00:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }
    if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  cleanup()
  await page.viewport(1280, 900)
})

// The editor row both document pages build: a stand-in editor, the history
// beside it, and the positioned wrapper the shell provides.
function renderRow() {
  return render(
    <div style={{ height: '600px', width: '100%', display: 'flex' }}>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="editor-stand-in" />
        <VersionPanel workspaceId="sess_1" path="canvas-a" />
      </div>
    </div>,
  )
}

describe('VersionPanel narrow screens', () => {
  it('is a bottom sheet with a peek and a full stage under 768px, and a column above it', async () => {
    await page.viewport(375, 700)
    const { container } = renderRow()

    const row = container.querySelector('div.relative') as HTMLElement
    const panel = await screen.findByTestId('history-panel')

    // A sheet: full width, anchored to the bottom, leaving the document
    // above it visible. A 300px column beside a 375px editor is not a
    // layout, it is two unusable halves.
    const rowRect = row.getBoundingClientRect()
    const peek = panel.getBoundingClientRect()
    expect(peek.width).toBeCloseTo(rowRect.width, 0)
    expect(peek.bottom).toBeCloseTo(rowRect.bottom, 0)
    expect(peek.height / rowRect.height).toBeLessThan(0.6)
    expect(peek.height / rowRect.height).toBeGreaterThan(0.2)
    // Out of flow, so the editor keeps the whole width behind it.
    expect(screen.getByTestId('editor-stand-in').getBoundingClientRect().width).toBeCloseTo(
      rowRect.width,
      0,
    )

    // Second stage: the same sheet, taller, for reading a long history.
    const expand = screen.getByRole('button', { name: 'Expand history' })
    expect(expand.textContent).toBe('')
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    expand.click()

    const collapse = await screen.findByRole('button', { name: 'Collapse history' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    const full = panel.getBoundingClientRect()
    expect(full.height / rowRect.height).toBeGreaterThan(0.9)
    expect(full.bottom).toBeCloseTo(rowRect.bottom, 0)

    collapse.click()
    await screen.findByRole('button', { name: 'Expand history' })
    expect(panel.getBoundingClientRect().height).toBeCloseTo(peek.height, 0)
  })

  it('keeps the column, and no stage control, on a wide screen', async () => {
    await page.viewport(1280, 900)
    const { container } = renderRow()

    const row = container.querySelector('div.relative') as HTMLElement
    const panel = await screen.findByTestId('history-panel')

    const rowRect = row.getBoundingClientRect()
    const rect = panel.getBoundingClientRect()
    expect(rect.width).toBeCloseTo(300, 0)
    expect(rect.height).toBeCloseTo(rowRect.height, 0)
    expect(rect.left).toBeGreaterThan(rowRect.left + 100)
    // In flow: the editor gives up the column's width rather than sitting
    // underneath it.
    expect(screen.getByTestId('editor-stand-in').getBoundingClientRect().width).toBeCloseTo(
      rowRect.width - 300,
      0,
    )

    // The stage control is a sheet affordance; a column has one height.
    const stage = screen.getByTestId('history-stage-toggle')
    expect((stage as HTMLElement).checkVisibility()).toBe(false)
  })
})
