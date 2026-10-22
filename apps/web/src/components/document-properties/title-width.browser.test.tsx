// Real-layout guard: the title shares a phone-width row with the page's
// actions, which do not shrink, so it must keep a readable floor.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import { DocumentProperties } from './DocumentProperties.js'

afterEach(cleanup)

function renderRow() {
  return render(
    <div style={{ width: 230 }} className="flex">
      <DocumentProperties
        inline
        title="Commute notes and other things"
        onTitleChange={vi.fn(async () => null)}
        actions={
          <>
            <button type="button" className="size-11 shrink-0">
              a
            </button>
            <button type="button" className="size-11 shrink-0">
              b
            </button>
            <button type="button" className="size-11 shrink-0">
              c
            </button>
            <button type="button" className="size-11 shrink-0">
              d
            </button>
          </>
        }
      />
    </div>,
  )
}

it('the title keeps room for about ten characters beside wide actions', () => {
  renderRow()
  const input = screen.getByRole('textbox', { name: 'Title' })
  expect(input.clientWidth).toBeGreaterThanOrEqual(70)
})

it('the title shows a focus ring a keyboard user can see', async () => {
  renderRow()
  const input = screen.getByRole('textbox', { name: 'Title' })
  await userEvent.tab()
  expect(document.activeElement).toBe(input)
  const style = getComputedStyle(input)
  expect(style.outlineStyle).not.toBe('none')
  expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2)
})
