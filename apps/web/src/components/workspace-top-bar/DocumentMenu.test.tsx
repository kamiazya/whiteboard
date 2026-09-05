// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenuItem } from '../../components/ui/dropdown-menu.js'
import { DocumentMenu } from './DocumentMenu'

function renderMenu(props?: {
  onExport?: (format: 'png' | 'svg') => void
  onBookmark?: () => void
  display?: React.ReactNode
  children?: React.ReactNode
}) {
  // Radix portals render into document.body, a DOM sibling of the default
  // container — rooting React at body is what lets portal events reach it.
  return render(
    <DocumentMenu
      onExport={props?.onExport}
      {...(props?.onBookmark === undefined ? {} : { onBookmark: props.onBookmark })}
      {...(props?.display === undefined ? {} : { display: props.display })}
    >
      {props?.children}
    </DocumentMenu>,
    { container: document.body },
  )
}

// Radix DropdownMenuTrigger opens on pointerDown; DropdownMenuItem selects on pointerUp.
async function openMenu() {
  fireEvent.pointerDown(screen.getByLabelText('More actions'), { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

// A submenu opens on pointerMove over its trigger (Radix's hover intent) —
// keyboard would work too, but the whole menu is driven by pointer here.
async function openExportSubmenu() {
  const trigger = screen.getByRole('menuitem', { name: 'Export…' })
  fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
  return waitFor(() => expect(screen.getByRole('menuitem', { name: 'Export as PNG' })).toBeTruthy())
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DocumentMenu — export entries', () => {
  it('renders no export entry when onExport is omitted', async () => {
    renderMenu()
    await openMenu()

    expect(screen.queryByText('Export…')).toBeNull()
    expect(screen.queryByText('Export as PNG')).toBeNull()
  })

  // ONE row for exporting, with the formats behind it. Two sibling rows made
  // the menu's length a function of how many formats exist, and a format is
  // not a different act — it is the same act, parameterised.
  it('offers one Export row, and keeps the formats behind it until it is opened', async () => {
    renderMenu({ onExport: vi.fn() })
    await openMenu()

    expect(screen.getByRole('menuitem', { name: 'Export…' })).toBeTruthy()
    expect(screen.queryByText('Export as PNG')).toBeNull()
    expect(screen.queryByText('Export as SVG')).toBeNull()
  })

  // Selecting an export closes the menu (Radix's default), so each format
  // gets its own open rather than two selections from one.
  it.each(['png', 'svg'] as const)('invokes onExport with %s', async (format) => {
    const onExport = vi.fn()
    renderMenu({ onExport })
    await openMenu()
    await openExportSubmenu()

    fireEvent.pointerUp(screen.getByText(`Export as ${format.toUpperCase()}`))
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(format))
  })

  // No export path — this app's or Excalidraw's own — produces a PDF or a
  // .excalidraw bundle, so neither may be offered here.
  it('offers PNG and SVG only', async () => {
    renderMenu({ onExport: vi.fn() })
    await openMenu()
    await openExportSubmenu()

    expect(screen.getByText('Export as PNG')).toBeTruthy()
    expect(screen.getByText('Export as SVG')).toBeTruthy()
    expect(screen.queryByText(/Export as (JSON|Excalidraw|PDF)/i)).toBeNull()
  })
})

/**
 * Display settings used to be a gear of their own in the row, beside the
 * properties toggle. It is the only VIEW control the document row carried,
 * and one icon for one plugin's edge routing is a poor trade against the
 * width the title wants — so it moves into the menu, in the leading band
 * ADR-0006 reserves for properties.
 */
describe('DocumentMenu — display settings', () => {
  it('has no Display row when the document has no canvas to configure', async () => {
    renderMenu({ onExport: vi.fn() })
    await openMenu()

    expect(screen.queryByText('Display…')).toBeNull()
  })

  it('puts Display… in the leading band, ahead of the verbs', async () => {
    renderMenu({ onExport: vi.fn(), display: <div>edge routing</div> })
    await openMenu()

    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())
    expect(labels[0]).toBe('Display…')
  })

  // The panel is a POPOVER, not a submenu: its widgets are segmented
  // controls a person adjusts several times in a row, and a menu closes on
  // the first select. It hangs off the kebab because the row that opened it
  // unmounted with the menu.
  it('opens the panel from that row', async () => {
    renderMenu({ onExport: vi.fn(), display: <div>edge routing</div> })
    await openMenu()

    expect(screen.queryByText('edge routing')).toBeNull()
    fireEvent.pointerUp(screen.getByRole('menuitem', { name: 'Display…' }))
    await waitFor(() => expect(screen.getByText('edge routing')).toBeTruthy())
  })

  it('renders no display control of its own in the row', () => {
    renderMenu({ onExport: vi.fn(), display: <div>edge routing</div> })

    expect(screen.queryByRole('button', { name: 'Display settings' })).toBeNull()
  })
})

/**
 * Bookmarking a point was reachable only while the History column was open,
 * which is backwards: you decide a point is worth naming while you are
 * working, not while you are reading the list. The row asks for one; the
 * naming still happens beside the list, which is where an unnamed row would
 * be indistinguishable from the checkpoint above it.
 */
describe('DocumentMenu — bookmark', () => {
  it('has no Bookmark row when the keeper writes no history', async () => {
    renderMenu({ onExport: vi.fn() })
    await openMenu()

    expect(screen.queryByText(/bookmark/i)).toBeNull()
  })

  it('asks for a bookmark', async () => {
    const onBookmark = vi.fn()
    renderMenu({ onExport: vi.fn(), onBookmark })
    await openMenu()

    fireEvent.pointerUp(screen.getByRole('menuitem', { name: 'Bookmark this point…' }))
    await waitFor(() => expect(onBookmark).toHaveBeenCalledTimes(1))
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
    expect(labels).toEqual(['Export…', 'Delete'])
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
