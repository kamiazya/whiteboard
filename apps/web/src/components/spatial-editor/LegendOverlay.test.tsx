import type { SceneLegend } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LegendOverlay } from './LegendOverlay.js'

afterEach(cleanup)

const legend: SceneLegend = {
  keys: [
    {
      key: 'health',
      of: 'boxes',
      entries: [
        {
          value: 'failing',
          count: 1,
          swatch: { fill: 'rgb(255, 238, 238)', stroke: 'rgb(204, 0, 0)' },
        },
        { value: '', count: 1, swatch: { fill: 'rgb(255, 255, 255)', stroke: 'rgb(64, 64, 64)' } },
      ],
    },
    {
      key: 'link',
      of: 'edges',
      entries: [{ value: 'slow', count: 2, swatch: { stroke: 'rgb(204, 102, 0)' } }],
    },
  ],
  uncarried: { boxes: false, edges: true },
}

describe('LegendOverlay', () => {
  it('lists each key’s values with the swatch the class is drawn in, the untagged class named', () => {
    render(<LegendOverlay legend={legend} />)
    expect(screen.getByText('health')).not.toBeNull()
    const failing = screen.getByTestId('legend-boxes-failing')
    expect(failing.textContent).toBe('failing')
    const box = failing.querySelector('span[aria-hidden]') as HTMLElement
    expect(box.style.background).toBe('rgb(255, 238, 238)')
    expect(box.style.border).toContain('rgb(204, 0, 0)')
    expect(screen.getByTestId('legend-boxes-untagged').textContent).toBe('untagged')
    const slow = screen
      .getByTestId('legend-edges-slow')
      .querySelector('span[aria-hidden]') as HTMLElement
    expect(slow.style.borderTop).toContain('rgb(204, 102, 0)')
    expect(screen.getByText('edge colour: no key carries it')).not.toBeNull()
    expect(screen.queryByText('box colour: no key carries it')).toBeNull()
  })

  it('collapses to its title and expands again', () => {
    render(<LegendOverlay legend={legend} />)
    const toggle = screen.getByRole('button', { name: 'Toggle legend' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('health')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('health')).not.toBeNull()
  })
})
