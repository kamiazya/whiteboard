// The verbs shown in the toolbar itself, for a surface with room for them.
// Formatting buttons were removed from this strip once and are back; what
// makes that safe rather than a swing of taste is pinned here — the bar
// appears where it fits, drops verbs where it does not, acts on the caret,
// and never takes the caret away.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MARKDOWN_EDITOR_VERBS } from './editor-verbs.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const bar = () => document.querySelector('[data-testid="markdown-verb-bar"]') as HTMLElement | null
const slots = () =>
  [...(bar()?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label'))
const source = () => document.querySelector('.cm-content') as HTMLElement
const lastValue = (onChange: ReturnType<typeof vi.fn>) =>
  onChange.mock.calls.at(-1)?.[0] as string | undefined

async function mount(onChange = vi.fn()) {
  render(
    <div style={{ height: 400 }}>
      {/* With a comment seam: a host without one leaves that verb off, by design. */}
      <MarkdownEditor
        value="milk"
        onChange={onChange}
        autoFocus
        initialViewMode="write"
        onRequestComment={() => true}
      />
    </div>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  return onChange
}

it('shows every verb at a desktop width, in the table order that keeps bands together', async () => {
  await page.viewport(1280, 800)
  await mount()
  await vi.waitFor(() => expect(slots().length).toBeGreaterThan(0))
  // The bar draws no "…" of its own — ⋯ beside the view modes is the catalog.
  expect(slots()).toEqual(MARKDOWN_EDITOR_VERBS.map((spec) => spec.label))
})

it('runs a verb on the caret and leaves the caret in the editor', async () => {
  await page.viewport(1280, 800)
  const onChange = await mount()
  await vi.waitFor(() => expect(slots().length).toBeGreaterThan(0))

  // No selection is made first, deliberately: a verb resolves its own scope
  // from the caret (see rangeToActOn), which is what makes the bar usable
  // where selecting text is the awkward part. {Home} pins the caret inside
  // "milk" without a chord whose modifier differs per platform.
  await userEvent.click(source())
  await userEvent.keyboard('{Home}{ArrowRight}{ArrowRight}')
  await userEvent.click(screen.getByRole('button', { name: 'Bold' }))
  await vi.waitFor(() => expect(lastValue(onChange)).toBe('**milk**'))
  expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()

  // One slot that cycles, not a band of four (see MarkdownVerbBar).
  await userEvent.click(screen.getByRole('button', { name: 'Heading' }))
  await vi.waitFor(() => expect(lastValue(onChange)).toBe('# **milk**'))
})

it('drops the verbs a narrow width cannot hold rather than wrapping the strip', async () => {
  await page.viewport(420, 800)
  await mount()
  await vi.waitFor(() => expect(bar()).not.toBeNull())
  const narrow = slots().length
  expect(narrow).toBeLessThan(MARKDOWN_EDITOR_VERBS.length)

  await page.viewport(1280, 800)
  await vi.waitFor(() => expect(slots().length).toBe(MARKDOWN_EDITOR_VERBS.length))
})
