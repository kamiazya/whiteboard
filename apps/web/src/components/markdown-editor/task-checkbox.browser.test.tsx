/**
 * A task checkbox in the preview is a control: clicking the drawn box
 * rewrites its `[ ]` in the source, in Split and in Read alike.
 *
 * A real browser because the box is an unfilled SVG rect, and whether a
 * click lands on it at all is the browser's hit-testing, which jsdom does
 * not do.
 */
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor, type MarkdownEditorProps } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = ['# Plan', '', '- [ ] first', '  - [x] nested', '* [ ] star item'].join('\n')

let latest = BODY
function Harness({ mode }: { mode: NonNullable<MarkdownEditorProps['initialViewMode']> }) {
  const [value, setValue] = useState(BODY)
  latest = value
  return (
    <MarkdownEditor
      theme="light"
      value={value}
      onChange={setValue}
      initialViewMode={mode}
      previewDebounceMs={0}
    />
  )
}

const boxes = () => [
  ...document.querySelectorAll('[data-testid="markdown-preview-pane"] [role="checkbox"]'),
]

describe('task checkboxes in the preview', () => {
  for (const mode of ['split', 'read'] as const) {
    it(`toggle their source line on a click in ${mode} mode`, async () => {
      render(<Harness mode={mode} />)
      await expect.poll(() => boxes().length).toBe(3)
      await userEvent.click(boxes()[0] as Element)
      await expect.poll(() => latest).toBe(BODY.replace('- [ ] first', '- [x] first'))
      await expect.poll(() => boxes()[0]?.getAttribute('aria-checked')).toBe('true')
      await userEvent.click(boxes()[1] as Element)
      await expect.poll(() => latest).toContain('  - [ ] nested')
      await userEvent.click(boxes()[2] as Element)
      await expect.poll(() => latest).toContain('* [x] star item')
    })
  }

  it('toggle from the keyboard with Space on a focused box', async () => {
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    ;(boxes()[2] as SVGElement).focus()
    await userEvent.keyboard(' ')
    await expect.poll(() => latest).toContain('* [x] star item')
  })
})
