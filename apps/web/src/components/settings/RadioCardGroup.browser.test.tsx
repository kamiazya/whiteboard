import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { RadioCardGroup } from './RadioCardGroup.js'

afterEach(cleanup)

const OPTIONS = [
  { value: 'light', label: 'Light', icon: <span /> },
  { value: 'dark', label: 'Dark', icon: <span /> },
  { value: 'system', label: 'System', icon: <span /> },
]

function Harness({ initial = 'light' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <button type="button">before</button>
      <RadioCardGroup
        label="Theme"
        columns={3}
        options={OPTIONS}
        value={value}
        onChange={setValue}
      />
      <button type="button">after</button>
    </>
  )
}

const checked = () =>
  screen
    .getAllByRole('radio')
    .filter((r) => r.getAttribute('aria-checked') === 'true')
    .map((r) => r.textContent)

describe('the roving radio group', () => {
  it('is one tab stop that lands on the checked radio', async () => {
    render(<Harness initial="dark" />)
    screen.getByText('before').focus()
    await userEvent.tab()
    expect(document.activeElement?.textContent).toBe('Dark')
    await userEvent.tab()
    expect(document.activeElement?.textContent).toBe('after')
  })

  it('moves and selects with the arrow keys, wrapping at the ends', async () => {
    render(<Harness />)
    screen.getByText('before').focus()
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    expect(checked()).toEqual(['Dark'])
    expect(document.activeElement?.textContent).toBe('Dark')
    await userEvent.keyboard('{ArrowDown}')
    expect(checked()).toEqual(['System'])
    await userEvent.keyboard('{ArrowRight}')
    expect(checked()).toEqual(['Light'])
    await userEvent.keyboard('{ArrowLeft}')
    expect(checked()).toEqual(['System'])
    await userEvent.keyboard('{ArrowUp}')
    expect(checked()).toEqual(['Dark'])
  })
})
