/**
 * The canvas row (the document's name and the Properties opener) and the OKF
 * core-facet editor the opener asks the page's inspector slot for.
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
import { DocumentFacetsEditor, DocumentProperties } from './DocumentProperties.js'

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

describe('DocumentProperties', () => {
  it('shows the workspace name as the title, without needing the panel opened', () => {
    render(<DocumentProperties {...titleProps({ title: 'Release plan' })} facets={meta()} />)
    expect(textboxValue(/title/i)).toBe('Release plan')
  })

  it("labels the software keyboard's Enter as Done on the title field", () => {
    // The one keyboard extension point the web has: Enter finishes the edit
    // here, so the key says so instead of showing a return arrow.
    render(<DocumentProperties {...titleProps()} facets={meta()} />)
    expect(screen.getByRole('textbox', { name: /title/i }).getAttribute('enterkeyhint')).toBe(
      'done',
    )
  })

  it('offers only the opener: the facet editor lives in the inspector slot, not under the row', () => {
    const onToggleProperties = vi.fn()
    render(
      <DocumentProperties
        {...titleProps()}
        facets={meta()}
        onToggleProperties={onToggleProperties}
      />,
    )
    expect(screen.queryByRole('combobox', { name: /type/i })).toBeNull()

    // A press asks the page for the slot; nothing opens here, because the
    // row does not own the slot and a second editor under the header is the
    // overlay the retune retired.
    fireEvent.click(screen.getByRole('button', { name: /properties/i }))
    expect(onToggleProperties).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('combobox', { name: /type/i })).toBeNull()
  })

  it('reports an edited title through onTitleChange, and never as a facet', () => {
    const onChange = vi.fn()
    const onTitleChange = vi.fn()
    render(<DocumentProperties {...titleProps({ title: 'old', onTitleChange })} facets={meta()} />)

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
    render(<DocumentProperties {...titleProps({ title: 'old', onTitleChange })} facets={meta()} />)

    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), { target: { value: '  ' } })
    expect(onTitleChange).toHaveBeenCalledWith('  ')
  })

  it('preserves facetsRaw across an edit to another field', () => {
    const onChange = vi.fn()
    const withRaw = meta({ facetsRaw: { author: 'kamiazya' } })
    render(<DocumentFacetsEditor facets={withRaw} onChange={onChange} />)

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
    const { rerender } = render(<DocumentFacetsEditor facets={meta()} onChange={onChange} />)

    const tagInput = screen.getByRole('textbox', { name: /add tag/i })
    fireEvent.change(tagInput, { target: { value: 'ops' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ type: 'markdown', tags: ['ops'] })

    rerender(<DocumentFacetsEditor facets={meta({ tags: ['ops'] })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /remove tag ops/i }))
    expect(onChange).toHaveBeenLastCalledWith({ type: 'markdown' })
  })

  it('does not commit a tag on the Enter that confirms an IME composition', () => {
    const onChange = vi.fn()
    render(<DocumentFacetsEditor facets={meta({ tags: [] })} onChange={onChange} />)
    const box = screen.getByRole('textbox', { name: /add tag/i })
    fireEvent.change(box, { target: { value: '\u4f01\u753b' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores a duplicate or blank tag instead of storing it', () => {
    const onChange = vi.fn()
    render(<DocumentFacetsEditor facets={meta({ tags: ['ops'] })} onChange={onChange} />)

    const tagInput = screen.getByRole('textbox', { name: /add tag/i })
    for (const value of ['ops', '   ']) {
      fireEvent.change(tagInput, { target: { value } })
      fireEvent.keyDown(tagInput, { key: 'Enter' })
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  // Queried by the VISIBLE label, which is also the accessible name — neither
  // field carries an `aria-label`, so what a voice-control user says matches.
  it('edits the OKF description, and clears it to absent rather than to an empty string', () => {
    const onChange = vi.fn()
    render(
      <DocumentFacetsEditor
        facets={meta({ description: 'One row per order.' })}
        onChange={onChange}
      />,
    )

    const box = screen.getByRole('textbox', { name: /summary/i })
    expect((box as HTMLInputElement).value).toBe('One row per order.')

    fireEvent.change(box, { target: { value: 'Completed orders, all channels.' } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'markdown',
      description: 'Completed orders, all channels.',
    })

    // A blank summary is no summary. Storing `description: ""` would emit an
    // empty key into the exported OKF for a reader to skip past.
    fireEvent.change(box, { target: { value: '   ' } })
    expect(onChange).toHaveBeenLastCalledWith({ type: 'markdown' })
  })

  it('edits the OKF resource, which §6.2 lets be a URL or a path', () => {
    const onChange = vi.fn()
    render(<DocumentFacetsEditor facets={meta()} onChange={onChange} />)

    const box = screen.getByRole('textbox', { name: /describes/i })
    fireEvent.change(box, { target: { value: '../computations/revenue.md' } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'markdown',
      resource: '../computations/revenue.md',
    })
  })

  it('preserves description and resource across an edit to another field', () => {
    const onChange = vi.fn()
    render(
      <DocumentFacetsEditor
        facets={meta({ description: 'A summary.', resource: 'https://example.com' })}
        onChange={onChange}
      />,
    )

    const tagInput = screen.getByRole('textbox', { name: /add tag/i })
    fireEvent.change(tagInput, { target: { value: 'ops' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({
      type: 'markdown',
      description: 'A summary.',
      resource: 'https://example.com',
      tags: ['ops'],
    })
  })

  it('refuses to emit an empty type, the one field the schema requires', () => {
    const onChange = vi.fn()
    render(<DocumentFacetsEditor facets={meta()} onChange={onChange} />)

    fireEvent.change(typeBox(), { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('DocumentProperties title typing (controlled-input round trip)', () => {
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
      <DocumentProperties
        title={current === 'untitled' ? '' : current}
        onTitleChange={onTitleChange}
        facets={{ type: 'markdown' }}
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

  // Escape can arrive in the SAME tick as the keystroke before it — a paste
  // followed by Escape, or any driver that dispatches both without yielding.
  // React batches across them, so the draft state the handler would read is
  // still the previous render's. Reading it there decides "nothing changed"
  // and leaves the abandoned name standing, which is the failure mode this
  // pins: no await between the change and the Escape.
  it('restores the previous name even when Escape lands in the same tick as the edit', () => {
    let current = 'Release plan'
    const onTitleChange = vi.fn((next: string) => {
      current = next
    })
    const view = () => (
      <DocumentProperties {...titleProps({ title: current, onTitleChange })} facets={meta()} />
    )
    render(view())

    const box = screen.getByRole('textbox', { name: /title/i })
    fireEvent.focus(box)
    // No rerender between the two: the component never sees the draft state
    // land before the Escape handler runs.
    fireEvent.change(box, { target: { value: 'Release pl' } })
    fireEvent.keyDown(box, { key: 'Escape' })

    expect(current).toBe('Release plan')
  })

  // The spatial editor guards its own bindings with isTextEntryEvent, but a
  // Delete typed into the title must not reach a canvas selection by any
  // route — this field is always mounted, right beside the canvas.
  it('keeps its keystrokes from bubbling out to editor-level listeners', () => {
    const onAncestorKeyDown = vi.fn()
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the page chrome that wraps this row
      <div onKeyDown={onAncestorKeyDown}>
        <DocumentProperties
          {...titleProps({ title: 'Release plan', onTitleChange: vi.fn() })}
          facets={meta()}
        />
      </div>,
    )

    fireEvent.keyDown(screen.getByRole('textbox', { name: /title/i }), { key: 'Delete' })

    expect(onAncestorKeyDown).not.toHaveBeenCalled()
  })

  // Enter is the universal "I'm done" for a single-line field, and every other
  // single-line input in this app already treats it that way. Here every
  // keystroke is already committed, so finishing means BLURRING — the focus
  // ring goes away and the save dot is the receipt. Without it the caret just
  // sits there and nothing says the name was kept.
  it('finishes the edit on Enter: the field blurs and keeps the typed name', () => {
    const onChange = vi.fn()
    render(
      <DocumentProperties
        {...titleProps({ title: 'Draft', onTitleChange: onChange })}
        facets={meta()}
      />,
    )
    const box = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
    box.focus()
    fireEvent.change(box, { target: { value: 'Release plan' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(document.activeElement).not.toBe(box)
    // Finishing must not revert: the typed name stands (Escape is the revert).
    expect(onChange).toHaveBeenLastCalledWith('Release plan')
  })

  // The Enter that CONFIRMS a Japanese/Chinese/Korean conversion is not "I am
  // done with the field" — swallowing it into a blur would end the edit in
  // the middle of typing a word. Both spellings of "an IME is active" must
  // hold the field open (see lib/ime-keydown.ts).
  it('stays focused on the Enter that confirms an IME composition', () => {
    render(<DocumentProperties {...titleProps({ title: 'Draft' })} facets={meta()} />)
    const box = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
    box.focus()
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(document.activeElement).toBe(box)

    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    expect(document.activeElement).toBe(box)
  })

  it('drops the draft on blur so the box shows the canonical name', () => {
    const onTitleChange = vi.fn()
    render(
      <DocumentProperties
        {...titleProps({ title: 'Release plan', onTitleChange })}
        facets={meta()}
      />,
    )
    const box = screen.getByRole('textbox', { name: /title/i })
    fireEvent.change(box, { target: { value: 'Release plan  ' } })
    expect(textboxValue(/title/i)).toBe('Release plan  ')

    fireEvent.blur(box)

    expect(textboxValue(/title/i)).toBe('Release plan')
  })
})

describe('DocumentProperties as the canvas row', () => {
  it('the Properties toggle is an icon button with a real accessible name, and reads the slot it is given', () => {
    const { rerender } = render(
      <DocumentProperties {...titleProps()} facets={{ type: 'markdown' }} propertiesOpen={false} />,
    )
    const toggle = screen.getByRole('button', { name: 'Properties' })
    // Icon-only: the word moved into aria-label + tooltip, off the surface.
    expect(toggle.textContent).not.toContain('Properties')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Controlled: the page's inspector slot decides, so a press alone
    // changes nothing here, and the prop is what the state follows.
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    rerender(
      <DocumentProperties {...titleProps()} facets={{ type: 'markdown' }} propertiesOpen={true} />,
    )
    expect(screen.getByRole('button', { name: 'Properties' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
  })

  it('renders the settings slot beside the toggle and the actions cluster at the right edge', () => {
    render(
      <DocumentProperties
        {...titleProps()}
        facets={{ type: 'markdown' }}
        settings={<button type="button" aria-label="Display settings" />}
        actions={<span data-testid="row-actions">ops</span>}
      />,
    )
    expect(screen.getByRole('button', { name: 'Display settings' })).toBeTruthy()
    expect(screen.getByTestId('row-actions')).toBeTruthy()
  })
})

describe('DocumentProperties inline variant (merged header row)', () => {
  it('renders as a row segment without its own chrome', () => {
    const { container } = render(
      <DocumentProperties inline {...titleProps()} facets={{ type: 'canvas' }} />,
    )
    const wrapper = container.firstElementChild as HTMLElement
    // No own border/背景 chrome — the merged header row provides it.
    expect(wrapper.className).not.toContain('border-b')
    expect(wrapper.className).toContain('flex-1')
  })
})

describe('a spatial document has no facets to edit', () => {
  // ADR-0009 decision 3: a facet is OKF frontmatter, and a JSON Canvas
  // document has none to hold one. The server refuses to write facets there,
  // so a spatial canvas passes none — and there is no shape in which it
  // hides the disclosure while still emitting through it.
  it('offers no properties disclosure', () => {
    render(<DocumentProperties {...titleProps()} />)

    expect(screen.queryByRole('button', { name: /properties/i })).toBeNull()
  })

  it('still shows the title, which is the workspace name and not a facet', () => {
    // The name is a workspace concern (ADR-0009 decision 2), so having no
    // facets must not take it with them.
    render(<DocumentProperties {...titleProps({ title: 'Architecture' })} />)

    expect(textboxValue(/title/i)).toBe('Architecture')
  })

  it('a markdown document keeps the disclosure', () => {
    render(<DocumentProperties {...titleProps()} facets={meta()} />)

    expect(screen.queryByRole('button', { name: /properties/i })).not.toBeNull()
  })
})
