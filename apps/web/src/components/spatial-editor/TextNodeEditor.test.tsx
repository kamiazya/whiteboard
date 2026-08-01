import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextNodeEditor } from './TextNodeEditor.js'

const BOX = { x: 10, y: 20, width: 100, height: 50 }

afterEach(() => {
  cleanup()
})

describe('TextNodeEditor', () => {
  it('cancels on Escape without committing', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByTestId('text-node-editor'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits on Cmd+Enter (metaKey)', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.change(screen.getByTestId('text-node-editor'), { target: { value: 'edited' } })
    fireEvent.keyDown(screen.getByTestId('text-node-editor'), { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('edited')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('commits on Ctrl+Enter (ctrlKey)', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.change(screen.getByTestId('text-node-editor'), { target: { value: 'edited' } })
    fireEvent.keyDown(screen.getByTestId('text-node-editor'), { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('edited')
  })

  it('does not commit on a plain Enter (no modifier)', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByTestId('text-node-editor'), { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
