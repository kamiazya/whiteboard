import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CanvasTitle } from './CanvasTitle.js'

describe('CanvasTitle', () => {
  afterEach(() => cleanup())

  it('renders the current name in a labeled textbox', () => {
    render(<CanvasTitle value="My canvas" onRename={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: /canvas title/i }) as HTMLInputElement
    expect(input.value).toBe('My canvas')
  })

  it('shows the normalized "untitled" in the field after committing an empty title', () => {
    render(<CanvasTitle value="My canvas" onRename={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: /canvas title/i }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    // The input must not stay blank while the canvas is actually named 'untitled'.
    expect(input.value).toBe('untitled')
  })

  it('does not clobber in-progress typing when the value prop changes (async load)', () => {
    // The snapshot loads asynchronously and can push a new `value` while the user
    // is mid-edit; the draft must win until the user commits.
    const { rerender } = render(<CanvasTitle value="" onRename={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: /canvas title/i }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Typing in progress' } })
    rerender(<CanvasTitle value="untitled" onRename={vi.fn()} />)
    expect(input.value).toBe('Typing in progress')
  })

  it('typing then pressing Enter commits the rename with the typed value', () => {
    const onRename = vi.fn()
    render(<CanvasTitle value="My canvas" onRename={onRename} />)
    const input = screen.getByRole('textbox', { name: /canvas title/i })
    fireEvent.change(input, { target: { value: 'Renamed via Enter' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('Renamed via Enter')
  })

  it('typing then blurring commits the rename with the typed value', () => {
    const onRename = vi.fn()
    render(<CanvasTitle value="My canvas" onRename={onRename} />)
    const input = screen.getByRole('textbox', { name: /canvas title/i })
    fireEvent.change(input, { target: { value: 'Renamed via blur' } })
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledWith('Renamed via blur')
  })

  it('pressing Escape reverts to the last committed name and does not call onRename', () => {
    const onRename = vi.fn()
    render(<CanvasTitle value="My canvas" onRename={onRename} />)
    const input = screen.getByRole('textbox', { name: /canvas title/i }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Should be discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRename).not.toHaveBeenCalled()
    expect(input.value).toBe('My canvas')
  })

  it('clearing the input and blurring falls back to "untitled" and still calls onRename', () => {
    const onRename = vi.fn()
    render(<CanvasTitle value="My canvas" onRename={onRename} />)
    const input = screen.getByRole('textbox', { name: /canvas title/i })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledWith('untitled')
  })

  it('keydown and keyup do not bubble to document listeners while editing', () => {
    const documentKeyDown = vi.fn()
    const documentKeyUp = vi.fn()
    document.addEventListener('keydown', documentKeyDown)
    document.addEventListener('keyup', documentKeyUp)
    try {
      render(<CanvasTitle value="My canvas" onRename={vi.fn()} />)
      const input = screen.getByRole('textbox', { name: /canvas title/i })
      fireEvent.keyDown(input, { key: 'Delete' })
      fireEvent.keyUp(input, { key: 'Delete' })
      expect(documentKeyDown).not.toHaveBeenCalled()
      expect(documentKeyUp).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', documentKeyDown)
      document.removeEventListener('keyup', documentKeyUp)
    }
  })
})
