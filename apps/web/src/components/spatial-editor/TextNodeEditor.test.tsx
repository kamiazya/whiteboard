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

  it('shows the exit hint below the editing box while open', () => {
    render(<TextNodeEditor box={BOX} initialText="hello" onCommit={vi.fn()} onCancel={vi.fn()} />)
    const hint = screen.getByTestId('editor-exit-hint')
    expect(hint.textContent).toContain('Done')
    // Rides the same canvas-space coordinates as the editor, just under it.
    expect(hint.style.top).toBe(`${BOX.y + BOX.height + 6}px`)
    expect(hint.style.left).toBe(`${BOX.x}px`)
  })

  it('a blur after Escape does not resurrect the cancelled edit as a commit', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />)
    const textarea = screen.getByTestId('text-node-editor')
    fireEvent.change(textarea, { target: { value: 'edited' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.blur(textarea)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a blur after Cmd+Enter does not duplicate the commit', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />)
    const textarea = screen.getByTestId('text-node-editor')
    fireEvent.change(textarea, { target: { value: 'edited' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    fireEvent.blur(textarea)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('edited')
  })

  describe('with a length limit', () => {
    const limit = { max: 5, describe: (length: number) => `would be ${length}` }
    const notice = () => screen.queryByTestId('text-node-editor-limit')

    it('refuses an edit past the limit, keeps the draft, and says why', () => {
      const onCommit = vi.fn()
      render(
        <TextNodeEditor
          box={BOX}
          initialText="abc"
          lengthLimit={limit}
          onCommit={onCommit}
          onCancel={vi.fn()}
        />,
      )
      const textarea = screen.getByTestId('text-node-editor') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'abcdef' } })
      expect(textarea.value).toBe('abc')
      expect(notice()?.textContent).toBe('would be 6')
      fireEvent.change(textarea, { target: { value: 'abcde' } })
      expect(notice()).toBeNull()
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
      expect(onCommit).toHaveBeenCalledWith('abcde')
    })

    it('lets a draft already past the limit shrink', () => {
      render(
        <TextNodeEditor
          box={BOX}
          initialText="abcdefgh"
          lengthLimit={limit}
          onCommit={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
      const textarea = screen.getByTestId('text-node-editor') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'abcdefg' } })
      expect(textarea.value).toBe('abcdefg')
      expect(notice()).toBeNull()
    })
  })
})
