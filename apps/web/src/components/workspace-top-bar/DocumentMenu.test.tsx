// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { DocumentMenu } from './DocumentMenu'

function renderMenu(props?: {
  onExport?: (format: 'png' | 'svg') => void
  children?: React.ReactNode
}) {
  // Radix portals render into document.body, a DOM sibling of the default
  // container — rooting React at body is what lets portal events reach it.
  return render(<DocumentMenu onExport={props?.onExport}>{props?.children}</DocumentMenu>, {
    container: document.body,
  })
}

// Radix DropdownMenuTrigger opens on pointerDown; DropdownMenuItem selects on pointerUp.
async function openMenu() {
  fireEvent.pointerDown(screen.getByLabelText('More actions'), { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
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
    expect(labels).toEqual(['Export as PNG', 'Export as SVG', 'Delete'])
  })
})

// Handing out a link is a promise the keeper may not be able to keep: a
// browser-kept document is reachable from no other browser, and the link this
// menu used to copy was built from the document's PATH, so renaming it broke
// every link already handed out. The affordance is gone until sharing is
// designed against the keeper that has to honour it.
describe('DocumentMenu — no link handout', () => {
  it('offers nothing that copies a link', async () => {
    renderMenu({ onExport: vi.fn() })
    await openMenu()

    expect(screen.queryByText(/copy link/i)).toBeNull()
    expect(screen.queryByText(/copied/i)).toBeNull()
  })

  it('mounts no copy-status live region and no fallback link field', async () => {
    renderMenu({ onExport: vi.fn() })
    await openMenu()

    expect(screen.queryByRole('status', { name: /copy status/i })).toBeNull()
    expect(screen.queryByLabelText(/document link/i)).toBeNull()
  })
})
