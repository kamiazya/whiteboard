/**
 * The OKF core-facet editor. `writeCoreFacets` REPLACES the whole bucket
 * rather than merging, so every edit here has to hand back a complete
 * `StoredCoreFacets` — including `facetsRaw`, the bucket holding root-level
 * frontmatter keys this app does not understand. Dropping it on a title
 * edit would silently delete a field the document arrived with.
 */
import type { StoredCoreFacets } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasProperties } from './CanvasProperties.js'

// An `<input list=...>` maps to role combobox, not textbox — the datalist
// is what makes `type` offer completions while staying free text.
function typeBox(): HTMLInputElement {
  return screen.getByRole('combobox', { name: /type/i }) as HTMLInputElement
}

function textboxValue(name: RegExp): string {
  return (screen.getByRole('textbox', { name }) as HTMLInputElement).value
}

afterEach(cleanup)

function meta(overrides: Partial<StoredCoreFacets> = {}): StoredCoreFacets {
  return { type: 'markdown', ...overrides }
}

describe('CanvasProperties', () => {
  it('shows the title without needing the panel opened', () => {
    render(<CanvasProperties meta={meta({ title: 'Release plan' })} onChange={vi.fn()} />)
    expect(textboxValue(/title/i)).toBe('Release plan')
  })

  it('keeps type and tags behind the disclosure until it is opened', async () => {
    render(<CanvasProperties meta={meta()} onChange={vi.fn()} />)
    expect(screen.queryByRole('combobox', { name: /type/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /properties/i }))
    expect(typeBox().value).toBe('markdown')
  })

  it('emits the edited title', () => {
    const onChange = vi.fn()
    render(<CanvasProperties meta={meta({ title: 'old' })} onChange={onChange} />)

    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), {
      target: { value: 'new' },
    })
    expect(onChange).toHaveBeenCalledWith({ type: 'markdown', title: 'new' })
  })

  it('drops the title field entirely when cleared, rather than storing an empty string', () => {
    const onChange = vi.fn()
    render(<CanvasProperties meta={meta({ title: 'old' })} onChange={onChange} />)

    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), { target: { value: '  ' } })
    expect(onChange).toHaveBeenCalledWith({ type: 'markdown' })
  })

  it('preserves facetsRaw across an edit to another field', () => {
    const onChange = vi.fn()
    const withRaw = meta({ title: 'kept', facetsRaw: { author: 'kamiazya' } })
    render(<CanvasProperties meta={withRaw} onChange={onChange} />)

    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), {
      target: { value: 'edited' },
    })
    expect(onChange).toHaveBeenCalledWith({
      type: 'markdown',
      title: 'edited',
      facetsRaw: { author: 'kamiazya' },
    })
  })

  it('adds a tag on Enter and removes it again', () => {
    const onChange = vi.fn()
    const { rerender } = render(<CanvasProperties meta={meta()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /properties/i }))

    const tagInput = screen.getByRole('textbox', { name: /add tag/i })
    fireEvent.change(tagInput, { target: { value: 'ops' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ type: 'markdown', tags: ['ops'] })

    // No second Properties click: rerender keeps the same instance, so the
    // panel is still open — clicking again would close it.
    rerender(<CanvasProperties meta={meta({ tags: ['ops'] })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /remove tag ops/i }))
    expect(onChange).toHaveBeenLastCalledWith({ type: 'markdown' })
  })

  it('ignores a duplicate or blank tag instead of storing it', () => {
    const onChange = vi.fn()
    render(<CanvasProperties meta={meta({ tags: ['ops'] })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /properties/i }))

    const tagInput = screen.getByRole('textbox', { name: /add tag/i })
    for (const value of ['ops', '   ']) {
      fireEvent.change(tagInput, { target: { value } })
      fireEvent.keyDown(tagInput, { key: 'Enter' })
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses to emit an empty type, the one field the schema requires', () => {
    const onChange = vi.fn()
    render(<CanvasProperties meta={meta()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /properties/i }))

    fireEvent.change(typeBox(), { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('CanvasProperties title typing (controlled-input round trip)', () => {
  // The input is controlled from `meta.title`, so whatever `withTitle`
  // returns is what the box shows on the very next render. Trimming there
  // erases a space the moment it is typed: the user cannot put one in.
  it('lets a space be typed in the middle of a title', () => {
    let current: StoredCoreFacets = { type: 'markdown' }
    const onChange = vi.fn((next: StoredCoreFacets) => {
      current = next
    })
    const { rerender } = render(<CanvasProperties meta={current} onChange={onChange} />)

    // Each keystroke APPENDS to whatever the box currently holds, which is
    // what a browser does — feeding a hand-written "Release p" instead would
    // supply a value the real DOM can never have once the space is swallowed.
    for (const key of [...'Release plan']) {
      const box = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      fireEvent.change(box, { target: { value: box.value + key } })
      rerender(<CanvasProperties meta={current} onChange={onChange} />)
    }

    expect(current.title).toBe('Release plan')
  })

  it('still drops the field for a whitespace-only title', () => {
    const onChange = vi.fn()
    render(<CanvasProperties meta={{ type: 'markdown', title: 'old' }} onChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), { target: { value: '   ' } })
    expect(onChange).toHaveBeenCalledWith({ type: 'markdown' })
  })
})

describe('CanvasProperties as the canvas row', () => {
  it('the Properties toggle is an icon button with a real accessible name and controls link', () => {
    render(<CanvasProperties meta={{ type: 'markdown' }} onChange={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: 'Properties' })
    // Icon-only: the word moved into aria-label + tooltip, off the surface.
    expect(toggle.textContent).not.toContain('Properties')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const disclosureId = toggle.getAttribute('aria-controls')
    expect(disclosureId).toBeTruthy()
    expect(document.getElementById(disclosureId as string)).toBeTruthy()
  })

  it('renders the settings slot beside the toggle and the actions cluster at the right edge', () => {
    render(
      <CanvasProperties
        meta={{ type: 'markdown' }}
        onChange={vi.fn()}
        settings={<button type="button" aria-label="Display settings" />}
        actions={<span data-testid="row-actions">ops</span>}
      />,
    )
    expect(screen.getByRole('button', { name: 'Display settings' })).toBeTruthy()
    expect(screen.getByTestId('row-actions')).toBeTruthy()
  })
})

describe('CanvasProperties inline variant (merged header row)', () => {
  it('renders as a row segment without its own chrome, and the disclosure overlays', () => {
    const { container } = render(
      <CanvasProperties inline meta={{ type: 'canvas' }} onChange={() => {}} />,
    )
    const wrapper = container.firstElementChild as HTMLElement
    // No own border/背景 chrome — the merged header row provides it.
    expect(wrapper.className).not.toContain('border-b')
    expect(wrapper.className).toContain('flex-1')

    fireEvent.click(screen.getByRole('button', { name: 'Properties' }))
    const disclosure = container.querySelector('[id$="-disclosure"]') as HTMLElement
    expect(disclosure).toBeTruthy()
    // Overlay below the header instead of growing the row.
    expect(disclosure.className).toContain('absolute')
  })
})

describe('a spatial document has no facets to edit', () => {
  // ADR-0009 decision 3: a facet is OKF frontmatter, and a JSON Canvas
  // document has none to hold one. The server refuses to write facets there;
  // offering the editor is the same claim made in the UI.
  it('offers no properties disclosure', () => {
    render(<CanvasProperties meta={meta()} onChange={vi.fn()} showFacets={false} />)

    expect(screen.queryByRole('button', { name: /properties/i })).toBeNull()
  })

  it('still shows the title, which is the workspace name and not a facet', () => {
    // The name is a workspace concern (ADR-0009 decision 2) that this editor
    // still keeps in core meta for browser-local canvases. Hiding the facet
    // disclosure must not take the name with it.
    render(
      <CanvasProperties
        meta={meta({ title: 'Architecture' })}
        onChange={vi.fn()}
        showFacets={false}
      />,
    )

    expect(textboxValue(/title/i)).toBe('Architecture')
  })

  it('a markdown document keeps the disclosure', () => {
    render(<CanvasProperties meta={meta()} onChange={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /properties/i })).not.toBeNull()
  })
})
