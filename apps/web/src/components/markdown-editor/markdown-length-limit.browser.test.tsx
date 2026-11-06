/**
 * A paste that would take the document past `MARKDOWN_MAX_CHARS`, through the
 * real CodeMirror input path.
 *
 * Either keeper refuses such a body, and a daemon-kept document's sync worker
 * retries a refused write without end, so the edit has to be refused where the
 * person made it — and say so, or a paste that did nothing reads as a broken
 * clipboard.
 */
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { markdownBodyNotice } from '../../lib/limit-notice.js'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

function mountEditor(value: string) {
  const onChange = vi.fn()
  const utils = render(
    <MarkdownEditor theme="light" initialViewMode="write" value={value} onChange={onChange} />,
  )
  const editable = () =>
    utils.getByTestId('markdown-source-pane').querySelector<HTMLElement>('[contenteditable="true"]')
  return { utils, onChange, editable }
}

/** The limit's own notice: the source pane's task region is a status region too, always mounted. */
const limitNotices = (utils: ReturnType<typeof mountEditor>['utils']) =>
  utils
    .queryAllByRole('status')
    .filter((el) => el.getAttribute('data-testid') !== 'source-task-announcement')

function paste(target: HTMLElement, text: string): void {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  fireEvent(target, new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
}

describe('pasting past the markdown size limit', () => {
  it('is refused, leaves the document as it was, and says why', async () => {
    const { utils, onChange, editable } = mountEditor('short')
    await focusEditable(editable)

    paste(editable() as HTMLElement, 'x'.repeat(MARKDOWN_MAX_CHARS))

    const notice = await vi.waitFor(() => {
      const [found] = limitNotices(utils)
      if (found === undefined) throw new Error('no limit notice yet')
      return found
    })
    expect(notice.textContent).toBe(
      markdownBodyNotice('added', 'short'.length + MARKDOWN_MAX_CHARS),
    )
    expect(onChange).not.toHaveBeenCalled()
    expect(editable()?.textContent).toBe('short')
  })

  it('within the limit lands and clears the notice', async () => {
    const { utils, onChange, editable } = mountEditor('short')
    await focusEditable(editable)
    paste(editable() as HTMLElement, 'x'.repeat(MARKDOWN_MAX_CHARS))
    await vi.waitFor(() => expect(limitNotices(utils)).toHaveLength(1))

    paste(editable() as HTMLElement, ' and more')

    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(limitNotices(utils)).toHaveLength(0)
  })
})
