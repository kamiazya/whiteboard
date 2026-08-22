// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { DocumentMenu } from './DocumentMenu'

const URL_UNDER_TEST = 'https://example.test/w/ws_1/document/canvas-a'

function renderMenu(props?: {
  onExport?: (format: 'png' | 'svg') => void
  documentUrl?: string
  children?: React.ReactNode
}) {
  // Radix portals render into document.body, a DOM sibling of the default
  // container — rooting React at body is what lets portal events reach it.
  return render(
    <DocumentMenu documentUrl={props?.documentUrl ?? URL_UNDER_TEST} onExport={props?.onExport}>
      {props?.children}
    </DocumentMenu>,
    { container: document.body },
  )
}

// Radix DropdownMenuTrigger opens on pointerDown; DropdownMenuItem selects on pointerUp.
async function openMenu() {
  fireEvent.pointerDown(screen.getByLabelText('More actions'), { button: 0, ctrlKey: false })
  return screen.findByText('Copy link')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DocumentMenu — export entries', () => {
  it('renders no export entries when onExport is omitted', async () => {
    renderMenu()
    await openMenu()

    expect(screen.queryByText('Export as PNG')).toBeNull()
    expect(screen.queryByText('Export as SVG')).toBeNull()
  })

  // Selecting an export closes the menu (Radix's default), so each format
  // gets its own open rather than two selections from one.
  it.each(['png', 'svg'] as const)('invokes onExport with %s', async (format) => {
    const onExport = vi.fn()
    renderMenu({ onExport })
    await openMenu()

    fireEvent.pointerUp(await screen.findByText(`Export as ${format.toUpperCase()}`))
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(format))
  })

  // No export path — this app's or Excalidraw's own — produces a PDF or a
  // .excalidraw bundle, so neither may be offered here.
  it('offers PNG and SVG only', async () => {
    renderMenu({ onExport: vi.fn() })
    await openMenu()

    expect(screen.getByText('Export as PNG')).toBeTruthy()
    expect(screen.getByText('Export as SVG')).toBeTruthy()
    expect(screen.queryByText(/Export as (JSON|Excalidraw|PDF)/i)).toBeNull()
  })
})

describe('DocumentMenu — page-contributed entries', () => {
  it("renders the page's own entries after the shared ones", async () => {
    renderMenu({
      onExport: vi.fn(),
      children: <DropdownMenuItem>Delete</DropdownMenuItem>,
    })
    await openMenu()

    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())
    expect(labels).toEqual(['Copy link', 'Export as PNG', 'Export as SVG', 'Delete'])
  })
})

describe('DocumentMenu — copy link feedback', () => {
  afterEach(() => {
    // @ts-expect-error -- test-only cleanup of a property defined per-test below
    delete navigator.clipboard
  })

  it('shows a "Copied!" confirmation after a successful copy, then reverts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    try {
      renderMenu()
      fireEvent.pointerUp(await openMenu())

      await vi.waitFor(() => expect(screen.getByText('Copied!')).toBeTruthy())
      expect(writeText).toHaveBeenCalledWith(URL_UNDER_TEST)
      // Screen-reader announcement, independent of the visible label swap.
      expect(screen.getByRole('status', { name: 'Copy status' }).textContent).toContain(
        'Document link copied to clipboard.',
      )

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      await vi.waitFor(() => expect(screen.queryByText('Copied!')).toBeNull())
      expect(screen.getByText('Copy link')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a rejected clipboard write as a visible error instead of a false success', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    renderMenu()
    fireEvent.pointerUp(await openMenu())

    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't copy automatically")
    expect(screen.queryByText('Copied!')).toBeNull()
    expect(screen.getByRole('status', { name: 'Copy status' }).textContent).toContain(
      "Couldn't copy the document link automatically.",
    )

    // Fallback: the link is still available as selectable text.
    const fallback = screen.getByLabelText('Document link') as HTMLInputElement
    expect(fallback.value).toBe(URL_UNDER_TEST)
    expect(fallback.readOnly).toBe(true)
  })

  it('does not nest the live region or the error fallback inside the role="menu" container', async () => {
    // WAI-ARIA menu pattern: an element with role="menu" may only own
    // menuitem/menuitemcheckbox/menuitemradio/group descendants. A
    // role="status"/role="alert" live region nested directly inside it
    // violates that contract (axe/AccessLint: aria-required-children) even
    // though the text is never focusable or reachable by arrow keys.
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    renderMenu()
    fireEvent.pointerUp(await openMenu())

    const alert = await screen.findByRole('alert')
    const status = screen.getByRole('status', { name: 'Copy status' })
    const menu = screen.getByRole('menu')

    expect(menu.contains(alert)).toBe(false)
    expect(menu.contains(status)).toBe(false)
  })
})
