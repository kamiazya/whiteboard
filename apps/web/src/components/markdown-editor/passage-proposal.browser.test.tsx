/**
 * Deciding a proposed passage from the body, in a real browser.
 *
 * Every half of this needs a live CodeMirror: the highlight is a decoration
 * the view builds, the affordance is a gutter marker it renders, and the card
 * is positioned from that marker's own box. A jsdom render has none of them.
 */
import type { Proposal } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = 'The plan is to ship on Thursday.'

function proposalOf(exact: string, text: string, assumed = exact): readonly Proposal[] {
  const start = BODY.indexOf(exact)
  return [
    {
      id: 'p1',
      changes: [
        {
          id: 'c1',
          op: 'body.replace',
          status: 'open',
          anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
          text,
          assumed,
        },
      ],
    },
  ]
}

describe('a proposed passage in the body', () => {
  it('draws the passage and opens a card that decides it', async () => {
    const onDecidePassage = vi.fn()
    const { container, getByRole, getByTestId, queryByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value={BODY}
        onChange={vi.fn()}
        proposals={proposalOf('Thursday', 'Friday')}
        onDecidePassage={onDecidePassage}
      />,
    )

    // The passage is marked where its quote is, not merely somewhere.
    const marked = await vi.waitFor(() => {
      const found = container.querySelector('.cm-proposal')
      expect(found?.textContent).toBe('Thursday')
      return found as HTMLElement
    })
    expect(marked.dataset.changeId).toBe('c1')

    // The gutter is the press target — the passage itself must stay
    // ordinary editable text.
    expect(queryByTestId('passage-proposal-card')).toBeNull()
    const marker = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('.cm-proposal-gutter-marker')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    await userEvent.click(marker)

    const card = getByTestId('passage-proposal-card')
    expect(card.textContent).toContain('Thursday')
    expect(card.textContent).toContain('Friday')

    await userEvent.click(getByRole('button', { name: 'Adopt this change' }))
    expect(onDecidePassage).toHaveBeenCalledWith('p1', 'c1', 'adopted')
    // The card closes on a decision: it was asking a question that now has
    // an answer, and leaving it open invites the same press twice.
    expect(queryByTestId('passage-proposal-card')).toBeNull()
  })

  it('says so when the words changed after the proposal was written', async () => {
    const { container, getByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value={BODY}
        onChange={vi.fn()}
        proposals={proposalOf('Thursday', 'Friday', 'Wednesday')}
        onDecidePassage={vi.fn()}
      />,
    )

    const marker = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('.cm-proposal-gutter-marker')
      expect(found?.dataset.conflicted).toBe('true')
      return found as HTMLElement
    })
    await userEvent.click(marker)

    expect(getByTestId('passage-proposal-card').textContent).toContain(
      'These words changed after this was proposed',
    )
  })

  it('opens the card from the keyboard, because the gutter target is a real button', async () => {
    const { container, getByTestId, queryByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value={BODY}
        onChange={vi.fn()}
        proposals={proposalOf('Thursday', 'Friday')}
        onDecidePassage={vi.fn()}
      />,
    )

    const marker = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('.cm-proposal-gutter-marker')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    // It is reachable by tab, so it has to answer what a tab-reached button
    // answers to. Enter and Space synthesize a `click`, never a `mousedown`.
    expect(marker.tabIndex).toBe(0)
    expect(queryByTestId('passage-proposal-card')).toBeNull()

    marker.focus()
    await userEvent.keyboard('{Enter}')
    expect(getByTestId('passage-proposal-card').textContent).toContain('Friday')
  })

  it('draws nothing for a change the person already decided', async () => {
    const decided: readonly Proposal[] = [
      {
        id: 'p1',
        changes: [
          {
            id: 'c1',
            op: 'body.replace',
            status: 'adopted',
            anchor: { kind: 'text', quote: { exact: 'Thursday' }, start: 23, end: 31 },
            text: 'Friday',
            assumed: 'Thursday',
          },
        ],
      },
    ]
    const { container } = render(
      <MarkdownEditor
        initialViewMode="write"
        value={BODY}
        onChange={vi.fn()}
        proposals={decided}
        onDecidePassage={vi.fn()}
      />,
    )

    await vi.waitFor(() => {
      expect(container.querySelector('.cm-proposal-gutter-marker')).toBeNull()
      expect(container.querySelector('.cm-proposal')).toBeNull()
    })
  })
})
