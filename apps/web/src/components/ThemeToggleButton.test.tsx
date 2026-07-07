import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeMode } from '../hooks/useThemeMode.js'
import { ThemeToggleButton } from './ThemeToggleButton.js'
import { TooltipProvider } from './ui/tooltip.js'

afterEach(() => cleanup())

function renderToggle(theme: ThemeMode, onChange: (next: ThemeMode) => void) {
  return render(
    <TooltipProvider>
      <ThemeToggleButton theme={theme} onChange={onChange} />
    </TooltipProvider>,
  )
}

describe('ThemeToggleButton', () => {
  it('labels and shows the correct icon per theme', () => {
    const { rerender } = render(
      <TooltipProvider>
        <ThemeToggleButton theme="system" onChange={() => {}} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Theme: system (follows OS) — click for light',
    )

    rerender(
      <TooltipProvider>
        <ThemeToggleButton theme="light" onChange={() => {}} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Theme: light — click for dark',
    )

    rerender(
      <TooltipProvider>
        <ThemeToggleButton theme="dark" onChange={() => {}} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Theme: dark — click for system',
    )
  })

  it('cycles system -> light -> dark -> system, one step per click driven by the controlling parent', () => {
    const onChange = vi.fn()
    const { rerender } = renderToggle('system', onChange)
    fireEvent.click(screen.getByRole('button'))
    expect(onChange).toHaveBeenNthCalledWith(1, 'light')

    rerender(
      <TooltipProvider>
        <ThemeToggleButton theme="light" onChange={onChange} />
      </TooltipProvider>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onChange).toHaveBeenNthCalledWith(2, 'dark')

    rerender(
      <TooltipProvider>
        <ThemeToggleButton theme="dark" onChange={onChange} />
      </TooltipProvider>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onChange).toHaveBeenNthCalledWith(3, 'system')

    expect(onChange).toHaveBeenCalledTimes(3)
  })
})
