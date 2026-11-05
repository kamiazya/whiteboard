// Skip to content lands on the page's content entry — and only on one a
// reader can see: a note in Read mode keeps its editor mounted but hidden,
// and focusing that is a no-op that leaves focus on the skip button.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SkipToContent } from './SkipToContent.js'

afterEach(cleanup)

// Hidden until focused, so it is reached the way a keyboard reaches it.
async function pressSkip() {
  page.getByRole('button', { name: 'Skip to content' }).element().focus()
  await userEvent.keyboard('{Enter}')
}

function Note({ editorShown }: { editorShown: boolean }) {
  return (
    <>
      <SkipToContent />
      <main>
        <div style={{ display: editorShown ? 'flex' : 'none' }}>
          <div contentEditable suppressContentEditableWarning data-testid="source">
            body
          </div>
        </div>
        <h1>Plan</h1>
      </main>
    </>
  )
}

it('focuses the editor when the note shows it', async () => {
  render(<Note editorShown />)
  await pressSkip()
  await expect.element(page.getByTestId('source')).toHaveFocus()
})

it('falls back to the page content when the editor is hidden', async () => {
  render(<Note editorShown={false} />)
  await pressSkip()
  await expect.element(page.getByRole('main')).toHaveFocus()
})
