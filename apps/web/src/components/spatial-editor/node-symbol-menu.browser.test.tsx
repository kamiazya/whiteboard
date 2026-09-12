// The Symbol band reached the menu with NO core-surface edit — it is a
// facet definition plus a widget registration. This locks the user flow: a
// pick stores visual.symbol/v0 and 'none' removes it without a trace.
//
// It also pins that the pick draws NOTHING on the node. A symbol marks the
// surfaces where a node is too small to read — the canvas overview here,
// covered by minimap.browser.test.tsx — and the node at full size already
// shows its own content.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { VisualSymbolFacet } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(() => {
  cleanup()
  window.scrollTo(0, 0)
})

const initial: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 80, y: 80, width: 200, height: 100, text: 'A' }],
  edges: [],
}

const symbolOf = (canvas: SpatialCanvas) =>
  canvas.nodes[0]?.['x-whiteboard']?.facets?.['visual.symbol/v0'] as VisualSymbolFacet | undefined

function makeHost(scrollable = false) {
  const latest: { canvas: SpatialCanvas } = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div
        style={{
          width: 800,
          height: 600,
          // Room to scroll in BOTH directions, so a case can stand the
          // trigger at a chosen height in the viewport instead of taking
          // whatever the page's own scroll-into-view left it at.
          ...(scrollable ? { marginTop: 2000, marginBottom: 2000 } : {}),
        }}
      >
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function openNodeMenu(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 180, clientY: r.top + 130 })
  return container.querySelector('[data-testid="context-menu"]') as HTMLElement
}

/**
 * Opens the Symbol picker's popover and answers the panel it drew.
 *
 * A catalog is hundreds of cells, so the row keeps one line and the picker
 * opens over it — which means every case here presses the trigger. Driven
 * rather than reached around on purpose: this is the path that exercises
 * the NATIVE Popover API, and jsdom has none of it (`catalog-popover.test.tsx`
 * runs the fallback).
 */
async function openSymbolPicker(panel: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(panel.querySelector('[aria-label="Choose symbol"]') as HTMLElement)
  return vi.waitFor(() => {
    const popover = document.querySelector('[role="dialog"][aria-label="Choose symbol"]')
    // The CATALOG, not just the search box: this build's own icons are its
    // first band now, so nothing but absence is on screen before it loads.
    expect(popover?.querySelector('[aria-label="Symbol categories"]')).not.toBeNull()
    return popover as HTMLElement
  })
}

/** Opens the node menu, then the inspector behind its one facet entry. */
function openInspector(container: HTMLElement): HTMLElement {
  const menu = openNodeMenu(container)
  const entry = [...menu.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').startsWith('Facets'),
  )
  expect(entry).toBeDefined()
  fireEvent.click(entry as HTMLElement)
  const opened = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  expect(opened).not.toBeNull()
  return opened
}

it('an icon pick stores the facet and draws nothing on the node', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const picker = await openSymbolPicker(openInspector(container))
  fireEvent.click(picker.querySelector('[aria-label="Icon star"]') as HTMLElement)

  expect(symbolOf(latest.canvas)).toEqual({ kind: 'icon', name: 'star' })
  // A vendored icon would be a <use> of its symbol; the node draws none.
  const drawn = container.querySelector('[data-testid="spatial-editor"] svg use[href^="#wb-icon-"]')
  expect(drawn).toBeNull()
})

/**
 * The emoji arm is reached by SEARCHING, because no listed option covers
 * it: the facet has accepted any single grapheme since it shipped, and the
 * picker used to offer five. The catalog arrives through a dynamic import
 * (a facet definition is loaded by the renderer and the MCP server too),
 * so the flow only exists once that has resolved — which is the half a
 * jsdom test of the declaration cannot see.
 */
it('an emoji found by search is stored rather than drawn, and No symbol removes the facet', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const glyphText = () =>
    [...container.querySelectorAll('[data-testid="spatial-editor"] svg text')]
      .map((t) => t.textContent)
      .filter((value) => value === '⭐')

  const picker = await openSymbolPicker(openInspector(container))
  const search = picker.querySelector('[aria-label="Search symbols"]') as HTMLInputElement
  fireEvent.change(search, { target: { value: 'star' } })
  const star = await vi.waitFor(() => {
    // Queried inside the assertion: the catalog mounts a band that was not
    // there when the popover opened.
    const el = picker.querySelector('[aria-label="star"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })

  fireEvent.click(star)
  expect(symbolOf(latest.canvas)).toEqual({ kind: 'emoji', char: '⭐' })
  // Stored, and not painted on the node.
  expect(glyphText()).toHaveLength(0)

  fireEvent.click(picker.querySelector('[aria-label="No symbol"]') as HTMLElement)
  expect(symbolOf(latest.canvas)).toBeUndefined()
  expect(latest.canvas.nodes[0]).not.toHaveProperty('x-whiteboard')
  expect(glyphText()).toHaveLength(0)
})

/**
 * The cause of a defect that looked like a data problem and was a font one:
 * an emoji left to the inherited stack is drawn by whichever installed font
 * claims its codepoint first, and several ordinary text faces claim the
 * common ones as MONOCHROME OUTLINES. Measured in this very browser —
 * `fc-match sans-serif` answers DejaVu Sans, which covers U+1F600 — so
 * 😀 😃 🙂 ☺️ ♠️ 🏁 drew as grey line art beside 🤣 🥰 ⭐ 🔥 in colour.
 *
 * Asserted on the COMPUTED family rather than on pixels because no API
 * reports which face actually won; what a browser can prove that jsdom
 * cannot is that the declaration survives the real cascade, which is where
 * a panel-wide font rule would have overridden it.
 */
it('draws its emoji in a font named for colour, not whichever one claims the codepoint', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const picker = await openSymbolPicker(openInspector(container))

  // Reached by SEARCH rather than by which band happens to be showing: the
  // catalog opens on this build's own icons, and which category leads is a
  // product decision this case has no business pinning.
  fireEvent.change(picker.querySelector('[aria-label="Search symbols"]') as HTMLInputElement, {
    target: { value: 'grinning_face' },
  })
  const cell = await vi.waitFor(() => {
    const el = picker.querySelector('[aria-label="grinning face"]')?.closest('label')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  const drawn = cell.querySelector('[aria-hidden="true"] span') as HTMLElement
  expect(drawn.textContent).toBe('😀')
  expect(getComputedStyle(drawn).fontFamily).toContain('Color Emoji')
})

/**
 * And the half a catalog of any size still cannot cover: a symbol nobody
 * listed. The template says the typed text is a `char`; what a char may be
 * stays the facet's own schema's answer, at the write boundary — so the
 * control needs no rule of its own and cannot have a laxer one.
 */
it('a symbol nobody listed is pasted into the one box, and a refused one is never offered', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const picker = await openSymbolPicker(openInspector(container))
  // ONE box: the search already matched a pasted character, so a free-entry
  // field beside it was the same gesture twice with only one of the two
  // writing anything. Free entry is a RESULT now.
  const search = picker.querySelector('[aria-label="Search symbols"]') as HTMLInputElement
  expect(picker.querySelector('[aria-label="Any character or emoji"]')).toBeNull()

  // Text the facet refuses is simply not offered — which beats a control
  // that takes it and then reports an error.
  fireEvent.change(search, { target: { value: 'ab' } })
  expect(symbolOf(latest.canvas)).toBeUndefined()
  expect(picker.querySelector('[aria-label="ab"]')).toBeNull()

  // A SKIN-TONED hand: one grapheme, accepted by the facet, and deliberately
  // not in the catalog — the generator drops 2030 tone variants because five
  // more copies of a waving hand make a grid worse to search. This is the
  // case free entry exists for, and 🦖 would not have shown it: the catalog
  // HAS a T-Rex, so what the box offers there is the row.
  fireEvent.change(search, { target: { value: '👍🏽' } })
  fireEvent.click(
    await vi.waitFor(() => {
      const el = picker.querySelector('[aria-label="👍🏽"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    }),
  )
  expect(symbolOf(latest.canvas)).toEqual({ kind: 'emoji', char: '👍🏽' })

  // And it comes back as a recent one, which is what makes free entry
  // usable more than once.
  await vi.waitFor(() => {
    const recent = picker.querySelector('[aria-label="Symbol recently used"]')
    expect(recent?.textContent).toContain('👍🏽')
  })
})

/**
 * The placement, on the path that has a TOP LAYER — which the jsdom cases
 * cannot reach and which is where the trap is. `position: fixed` neither
 * clips nor grows, and the top layer is not a scroll container either, so a
 * catalog opened from a row low in the viewport put its search box and
 * every one of its cells below the fold with nothing to scroll to them.
 *
 * The UA stylesheet is the second half: it gives `[popover]` `inset: 0`, so
 * an unwritten `top` is `0` rather than unset and the `bottom` meant to
 * hold the panel above its trigger is dropped as over-constrained. Only a
 * real browser has that sheet.
 *
 * Asserted as the invariant rather than as coordinates: whichever side it
 * chooses, all of it is on screen.
 */
it('opens a catalog entirely inside the viewport, from a row with no room under it', async () => {
  const { Host } = makeHost(true)
  const { container } = render(<Host />)

  const picker = await openSymbolPicker(openInspector(container))
  const trigger = container.querySelector('[aria-label="Choose symbol"]') as HTMLElement

  // Stand the trigger 40px off the bottom, which is far less than the panel
  // needs. SCROLLED there rather than laid out there: the page scrolls
  // itself when the inspector takes focus, so a spacer above the host
  // decides nothing — measured, an 820px spacer left 368px of clearance and
  // a 300px-tall viewport left 198px, both more than the panel's own 146,
  // and the case passed against the unfixed placement in each.
  window.scrollTo(
    0,
    trigger.getBoundingClientRect().bottom + window.scrollY - (window.innerHeight - 40),
  )
  fireEvent.scroll(document)

  const box = await vi.waitFor(() => {
    const rect = picker.getBoundingClientRect()
    // The premise, probed rather than assumed, and it is not "the trigger is
    // low" — it is that what the panel HOLDS does not fit under it.
    expect(window.innerHeight - trigger.getBoundingClientRect().bottom).toBeLessThan(
      picker.scrollHeight,
    )
    expect(rect.height).toBeGreaterThan(100)
    return rect
  })

  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
  // And what it holds is reachable at that height rather than cut off.
  expect(picker.scrollHeight).toBeLessThanOrEqual(Math.ceil(picker.clientHeight))
})
