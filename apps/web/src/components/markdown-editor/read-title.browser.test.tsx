import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

const previewText = (root: HTMLElement) =>
  root.querySelector('[data-testid="markdown-preview-pane"]')?.textContent ?? ''

describe('Read mode title (real browser)', () => {
  it('prints the document name once when the body opens with the same H1', async () => {
    const { container, getByTestId } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="read"
        value={'# Weekly sync\n\nAgenda items'}
        onChange={() => {}}
        title="Weekly sync"
        meta={{ type: 'note' }}
      />,
    )
    await vi.waitFor(() => {
      expect(previewText(container)).toContain('Agenda items')
    })
    expect(getByTestId('markdown-document-header').textContent).toContain('Weekly sync')
    expect(previewText(container)).not.toContain('Weekly sync')
  })

  it('keeps a body H1 that differs from the name, and the H1 outside Read mode', async () => {
    const { container, unmount } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="read"
        value={'# Quarterly goals\n\nAgenda items'}
        onChange={() => {}}
        title="Weekly sync"
        meta={{ type: 'note' }}
      />,
    )
    await vi.waitFor(() => {
      expect(previewText(container)).toContain('Quarterly goals')
    })
    unmount()
    const split = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="split"
        value={'# Weekly sync\n\nAgenda items'}
        onChange={() => {}}
        title="Weekly sync"
        meta={{ type: 'note' }}
      />,
    )
    await vi.waitFor(() => {
      expect(previewText(split.container)).toContain('Weekly sync')
    })
  })
})
