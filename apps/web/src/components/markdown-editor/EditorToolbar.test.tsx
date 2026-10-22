// The strip's controls step up to the touch floor on a coarse pointer through
// the `pointer-coarse:` variant (the dock's mechanism). Chromium cannot emulate
// the media feature, so the contract is pinned on the classes that carry it.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip.js'
import { EditorToolbar } from './EditorToolbar.js'

afterEach(cleanup)

function mount() {
  render(
    <TooltipProvider>
      <EditorToolbar
        mode="write"
        onModeChange={vi.fn()}
        splitAvailable
        wordCount={3}
        onOpenCatalog={vi.fn()}
        catalogAvailable
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />
    </TooltipProvider>,
  )
}

it.each([
  'Undo',
  'Redo',
  'Write',
  'Split',
  'Read',
  'Editing actions',
])('%s is 44px high on a coarse pointer', (name) => {
  mount()
  expect(screen.getByRole('button', { name }).className).toMatch(/pointer-coarse:(size|h)-11/)
})
