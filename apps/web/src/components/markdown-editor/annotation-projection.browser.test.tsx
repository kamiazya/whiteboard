/**
 * The in-place projection, in a real browser: the marked passage and the
 * gutter marker beside it have to actually reach the DOM, and a press on the
 * marker has to reach the host that owns the rail.
 *
 * Real CodeMirror rather than jsdom, because both halves are things a
 * decoration set only PROMISES: a mark reaches the text through the view's
 * own render, and a gutter marker exists only where a gutter was configured.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = 'Ship the report.\nIt is due on Friday, and the draft is not written.'

function thread(id: string, exact: string, overrides: Partial<CommentThread> = {}): CommentThread {
  const start = BODY.indexOf(exact)
  return {
    id,
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    status: 'open',
    messages: [{ id: `${id}-m1`, body: 'is that still true?' }],
    ...overrides,
  }
}

type EditorProps = Parameters<typeof MarkdownEditor>[0]

function mount(props: Partial<EditorProps>) {
  return render(
    <MarkdownEditor initialViewMode="write" value={BODY} onChange={vi.fn()} {...props} />,
  )
}

describe('markdown annotation projection', () => {
  it('marks the quoted passage and puts a marker in the gutter', async () => {
    const utils = mount({ threads: [thread('t1', 'due on Friday')] })
    await waitFor(() => {
      expect(
        utils.container.querySelector('[data-thread-id="t1"].cm-annotation')?.textContent,
      ).toBe('due on Friday')
    })
    expect(
      utils.container.querySelector('.cm-annotation-gutter-marker[data-thread-id="t1"]'),
    ).not.toBeNull()
  })

  it('leaves the body unmarked when the passage is gone', async () => {
    const utils = mount({ threads: [thread('t1', 'due on Friday')], value: 'Rewritten.' })
    // Give the projection effect a turn to land, so an empty result is the
    // answer rather than the moment before one.
    await waitFor(() => {
      expect(utils.container.querySelector('.cm-editor')).not.toBeNull()
    })
    expect(utils.container.querySelector('.cm-annotation')).toBeNull()
    expect(utils.container.querySelector('.cm-annotation-gutter-marker')).toBeNull()
  })

  it('tells the host which conversation a gutter press was about', async () => {
    const onSelectThread = vi.fn()
    const utils = mount({ threads: [thread('t1', 'due on Friday')], onSelectThread })
    const marker = await waitFor(() => {
      const found = utils.container.querySelector<HTMLElement>('.cm-annotation-gutter-marker')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onSelectThread).toHaveBeenCalledWith('t1')
  })

  const marked = (utils: { container: HTMLElement }) =>
    waitFor(() => {
      const found = utils.container.querySelector<HTMLElement>('.cm-annotation-gutter-marker')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })

  it('keeps a line second conversation visible when the two share one marker', async () => {
    const utils = mount({ threads: [thread('a', 'due on Friday'), thread('b', 'the draft')] })
    const marker = await marked(utils)
    // Both passages sit on the second line, so the gutter carries one marker
    // saying so rather than silently dropping the second conversation. The
    // NUMBER now belongs to the conversation rather than to the line — see
    // the test below — so the line's own count moves to an attribute the
    // stacked drawing keys on, and to the label.
    expect(utils.container.querySelectorAll('.cm-annotation-gutter-marker')).toHaveLength(1)
    expect(marker.dataset.threads).toBe('2')
    expect(marker.getAttribute('aria-label')).toBe('2 conversations on this line')
  })

  it('carries the conversation message count, so its weight is readable before opening', async () => {
    const utils = mount({
      threads: [
        thread('a', 'due on Friday', {
          messages: [
            { id: 'a-m1', body: 'is that still true?' },
            { id: 'a-m2', body: 'no, it slipped' },
            { id: 'a-m3', body: 'moved to Monday' },
          ],
        }),
      ],
    })
    const marker = await marked(utils)
    expect(marker.textContent).toBe('3')
    expect(marker.getAttribute('aria-label')).toBe('A conversation of 3 messages')
    // One conversation on the line, so nothing to stack.
    expect(marker.dataset.threads).toBeUndefined()
  })

  it('draws no number for a lone remark, where a digit would be noise beside prose', async () => {
    const utils = mount({ threads: [thread('a', 'due on Friday')] })
    const marker = await marked(utils)
    expect(marker.textContent).toBe('')
    expect(marker.getAttribute('aria-label')).toBe('A conversation on this line')
  })

  it('says both facts at once when a busy conversation shares its line', async () => {
    const utils = mount({
      threads: [
        thread('a', 'due on Friday', {
          messages: [
            { id: 'a-m1', body: 'is that still true?' },
            { id: 'a-m2', body: 'no' },
          ],
        }),
        thread('b', 'the draft'),
      ],
    })
    const marker = await marked(utils)
    expect(marker.getAttribute('aria-label')).toBe(
      'A conversation of 2 messages, one of 2 on this line',
    )
  })

  it('re-marks the passage after an edit above it moves every offset', async () => {
    const utils = mount({ threads: [thread('t1', 'due on Friday')] })
    await waitFor(() => {
      expect(utils.container.querySelector('[data-thread-id="t1"].cm-annotation')).not.toBeNull()
    })
    utils.rerender(
      <MarkdownEditor
        initialViewMode="write"
        value={`Standup note.\n${BODY}`}
        onChange={vi.fn()}
        threads={[thread('t1', 'due on Friday')]}
      />,
    )
    await waitFor(() => {
      // Scoped to the MARK: the gutter marker carries the same attribute and
      // comes first in the DOM, so an unscoped query answers about it and
      // reads as the passage having lost its text.
      expect(
        utils.container.querySelector('[data-thread-id="t1"].cm-annotation')?.textContent,
      ).toBe('due on Friday')
    })
  })

  it('follows the passage while the reader types above it', async () => {
    // The only thing that exercises the doc-change path on its own: the
    // thread list does not move, the TEXT does. Removing that path leaves
    // every other case in this file green, because each of them hands the
    // pane a new thread array and re-projects through the effect instead.
    // Hoisted, so the array identity does NOT change per keystroke. Inline it
    // and the projection effect re-fires on every render, which hides the
    // path this case exists to exercise — measured: the doc-change branch
    // could then be deleted with every test in this file still green.
    const stable = [thread('t1', 'due on Friday')]
    function Host() {
      const [value, setValue] = useState(BODY)
      return (
        <MarkdownEditor
          initialViewMode="write"
          value={value}
          onChange={setValue}
          threads={stable}
        />
      )
    }
    const utils = render(<Host />)
    const editable = () =>
      utils.getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]')
    await waitFor(() => {
      expect(utils.container.querySelector('[data-thread-id="t1"].cm-annotation')).not.toBeNull()
    })

    await focusEditable(editable)
    await userEvent.keyboard('{Control>}{Home}{/Control}')
    // ASCII only: a character with no keycode is synthesized separately and
    // is the one that goes missing under load.
    await userEvent.keyboard('note ')

    await waitFor(() => {
      expect(
        utils.container.querySelector('[data-thread-id="t1"].cm-annotation')?.textContent,
      ).toBe('due on Friday')
    })
  })
})
