/**
 * The canvas row: the document's name, plus the OKF core-facet editor.
 * `writeCoreFacets` REPLACES the whole bucket rather than merging, so every
 * facet edit here has to hand back a complete `StoredCoreFacets` — including
 * `facetsRaw`, the bucket holding root-level frontmatter keys this app does
 * not understand. Dropping it on a tag edit would silently delete a field the
 * document arrived with.
 *
 * The title is NOT one of those facets: it is the document's name, which
 * belongs to the workspace (ADR-0009 decision 2), so it arrives as its own
 * prop and leaves through its own callback.
 */
import type { StoredCoreFacets } from '@kamiazya/whiteboard-model'
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

/** The two title props every render needs, defaulted to an unnamed document. */
function titleProps(overrides: { title?: string; onTitleChange?: (next: string) => void } = {}) {
  return { title: '', onTitleChange: vi.fn(), ...overrides }
}

describe('CanvasProperties', () => {
  it('shows the workspace name as the title, without needing the panel opened', () => {
    render(
      <CanvasProperties
        {...titleProps({ title: 'Release plan' })}
        facets={meta()}
        onFacetsChange={vi.fn()}
      />,
    )
    expect(textboxValue(/title/i)).toBe('Release plan')
  })

  it('keeps type and tags behind the disclosure until it is opened', async () => {
    render(<CanvasProperties {...titleProps()} facets={meta()} onFacetsChange={vi.fn()} />)
    expect(screen.queryByRole('combobox', { name: /type/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /properties/i }))
    expect(typeBox().value).toBe('markdown')
  })

  it('reports an edited title through onTitleChange, and never as a facet', () => {
    const onChange = vi.fn()
    const onTitleChange = vi.fn()
    render(
      <CanvasProperties
        {...titleProps({ title: 'old', onTitleChange })}
        facets={meta()}
        onFacetsChange={onChange}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), {
      target: { value: 'new' },
    })
    expect(onTitleChange).toHaveBeenCalledWith('new')
    // The facet emit is the second source of truth this contract exists to
    // remove: a rename must not touch stored content at all.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports a cleared title as the empty string, which the workspace reads as unnamed', () => {
    const onTitleChange = vi.fn()
    render(
      <CanvasProperties
        {...titleProps({ title: 'old', onTitleChange })}
        facets={meta()}
        onFacetsChange={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), { target: { value: '  ' } })
    expect(onTitleChange).toHaveBeenCalledWith('  ')
  })

  it('preserves facetsRaw across an edit to another field', () => {
    const onChange = vi.fn()
    const withRaw = meta({ facetsRaw: { author: 'kamiazya' } })
    render(<CanvasProperties {...titleProps()} facets={withRaw} onFacetsChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /properties/i }))

    const tagInput = screen.getByRole('textbox', { name: /add tag/i })
    fireEvent.change(tagInput, { target: { value: 'ops' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({
      type: 'markdown',
      tags: ['ops'],
      facetsRaw: { author: 'kamiazya' },
    })
  })

  it('adds a tag on Enter and removes it again', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <CanvasProperties {...titleProps()} facets={meta()} onFacetsChange={onChange} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /properties/i }))

    const tagInput = screen.getByRole('textbox', { name: /add tag/i })
    fireEvent.change(tagInput, { target: { value: 'ops' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ type: 'markdown', tags: ['ops'] })

    // No second Properties click: rerender keeps the same instance, so the
    // panel is still open — clicking again would close it.
    rerender(
      <CanvasProperties
        {...titleProps()}
        facets={meta({ tags: ['ops'] })}
        onFacetsChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /remove tag ops/i }))
    expect(onChange).toHaveBeenLastCalledWith({ type: 'markdown' })
  })

  it('ignores a duplicate or blank tag instead of storing it', () => {
    const onChange = vi.fn()
    render(
      <CanvasProperties
        {...titleProps()}
        facets={meta({ tags: ['ops'] })}
        onFacetsChange={onChange}
      />,
    )
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
    render(<CanvasProperties {...titleProps()} facets={meta()} onFacetsChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /properties/i }))

    fireEvent.change(typeBox(), { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('CanvasProperties title typing (controlled-input round trip)', () => {
  // The name comes back NORMALISED — trimmed, and blank replaced by the
  // unnamed sentinel. Rendering that on the keystroke that typed a space
  // erases it, and the user cannot put one in.
  it('lets a space be typed in the middle of a title', () => {
    // Exactly what the workspace does with a name it is handed.
    let current = ''
    const onTitleChange = vi.fn((next: string) => {
      current = next.trim() || 'untitled'
    })
    const view = () => (
      <CanvasProperties
        title={current === 'untitled' ? '' : current}
        onTitleChange={onTitleChange}
        facets={{ type: 'markdown' }}
        onFacetsChange={vi.fn()}
      />
    )
    const { rerender } = render(view())

    // Each keystroke APPENDS to whatever the box currently holds, which is
    // what a browser does — feeding a hand-written "Release p" instead would
    // supply a value the real DOM can never have once the space is swallowed.
    for (const key of [...'Release plan']) {
      const box = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      fireEvent.change(box, { target: { value: box.value + key } })
      rerender(view())
    }

    expect(current).toBe('Release plan')
  })

  it('drops the draft on blur so the box shows the canonical name', () => {
    const onTitleChange = vi.fn()
    render(
      <CanvasProperties
        {...titleProps({ title: 'Release plan', onTitleChange })}
        facets={meta()}
        onFacetsChange={vi.fn()}
      />,
    )
    const box = screen.getByRole('textbox', { name: /title/i })
    fireEvent.change(box, { target: { value: 'Release plan  ' } })
    expect(textboxValue(/title/i)).toBe('Release plan  ')

    fireEvent.blur(box)

    expect(textboxValue(/title/i)).toBe('Release plan')
  })
})

describe('CanvasProperties as the canvas row', () => {
  it('the Properties toggle is an icon button with a real accessible name and controls link', () => {
    render(
      <CanvasProperties {...titleProps()} facets={{ type: 'markdown' }} onFacetsChange={vi.fn()} />,
    )
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
        {...titleProps()}
        facets={{ type: 'markdown' }}
        onFacetsChange={vi.fn()}
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
      <CanvasProperties
        inline
        {...titleProps()}
        facets={{ type: 'canvas' }}
        onFacetsChange={() => {}}
      />,
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
  // document has none to hold one. The server refuses to write facets there,
  // so a spatial canvas passes none — and there is no shape in which it
  // hides the disclosure while still emitting through it.
  it('offers no properties disclosure', () => {
    render(<CanvasProperties {...titleProps()} />)

    expect(screen.queryByRole('button', { name: /properties/i })).toBeNull()
  })

  it('still shows the title, which is the workspace name and not a facet', () => {
    // The name is a workspace concern (ADR-0009 decision 2), so having no
    // facets must not take it with them.
    render(<CanvasProperties {...titleProps({ title: 'Architecture' })} />)

    expect(textboxValue(/title/i)).toBe('Architecture')
  })

  it('a markdown document keeps the disclosure', () => {
    render(<CanvasProperties {...titleProps()} facets={meta()} onFacetsChange={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /properties/i })).not.toBeNull()
  })
})
