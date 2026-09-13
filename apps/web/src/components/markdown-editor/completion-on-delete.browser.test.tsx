/**
 * Backspacing into a name you already wrote offers the list again.
 *
 * The gap this closes, measured before it was written: while a popup is OPEN
 * a deletion keeps it (`validFor` covers a shrinking query), but once it is
 * closed nothing reopens it — and the ordinary way to fix a typo in a name
 * is to backspace into a shortcode that was finished long ago, where no
 * popup was ever open. Measured on `ship it :rocket:` + one backspace:
 * `status=null popup=false`.
 *
 * In a real browser rather than jsdom because the claim is about the
 * plugin's own activation, which is driven by transactions and timers the
 * extension set has to be real to exercise.
 */
import {
  autocompletion,
  type CompletionSource,
  closeCompletion,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from '../spatial-editor/SpatialEditor.js'
import { completionOnDelete } from './completion-on-delete.js'
import { MarkdownEditor } from './MarkdownEditor.js'
import { shortcodeCompletionSource } from './shortcode-completion.js'
import { wikiLinkCompletionSource } from './wiki-link-completion.js'

let view: EditorView | undefined

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  view?.destroy()
  view = undefined
  document.body.replaceChildren()
})

/** Both hosts' completion set, plus the extension under test. */
function open(
  doc: string,
  options: { activateOnTyping?: boolean; source?: CompletionSource } = {},
): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        autocompletion({
          override: [
            options.source ??
              wikiLinkCompletionSource(() => [
                { id: 'd1', name: 'Rocket notes', path: 'rocket-notes' },
              ]),
            ...(options.source === undefined ? [shortcodeCompletionSource] : []),
          ],
          interactionDelay: 0,
          ...(options.activateOnTyping === undefined
            ? {}
            : { activateOnTyping: options.activateOnTyping }),
        }),
        completionOnDelete(),
      ],
    }),
  })
  view.focus()
  return view
}

/** One backspace, the way the plugin sees the key. */
function backspace(target: EditorView): void {
  const at = target.state.selection.main.head
  target.dispatch({
    changes: { from: at - 1, to: at },
    selection: { anchor: at - 1 },
    userEvent: 'delete.backward',
  })
}

const popup = () => document.querySelector('.cm-tooltip-autocomplete')

/**
 * A synchronous stand-in for a real source, counting what it is asked.
 *
 * Synchronous on purpose: `shortcodeCompletionSource` reaches its index through
 * a dynamic import, and a promise resolving between two timer advances makes
 * a COUNT read as timing rather than as behaviour. What these two cases are
 * about is when the plugin asks, not what any source answers.
 */
function countingSource(asked: { calls: number }): CompletionSource {
  return (context) => {
    const match = context.matchBefore(/:[a-z0-9_]{2,}$/)
    if (match === null) return null
    asked.calls += 1
    return {
      from: match.from + 1,
      options: [{ label: 'rocket' }],
      validFor: /^[a-z0-9_]*$/,
    }
  }
}

/**
 * Past `activateOnTypingDelay` (the plugin documents 100ms), on FAKE timers.
 *
 * The separation is load-bearing rather than incidental: CodeMirror
 * coalesces activations that land in one tick, so three back-to-back
 * backspaces are a single query and a count over them says nothing. An
 * earlier version of these two cases dispatched without any separation and
 * both mutations came back green — the tests were vacuous, and looked
 * exactly like tests that checked. Fake timers rather than sleeps because
 * the thing being waited on IS a timer.
 */
async function pastActivation(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150)
}

describe('deleting back into a name offers the list again', () => {
  it('reopens on a shortcode that was already finished', async () => {
    const target = open('ship it :rocket:')
    expect(completionStatus(target.state)).toBeNull()

    backspace(target)
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))
    expect(popup()?.textContent).toContain('rocket')
  })

  /**
   * Source-agnostic on purpose: this extension asks the plugin to run its
   * sources and never learns a trigger of its own, so a third source added
   * later gets the behaviour without an edit here.
   */
  it('reopens for the wiki-link source too', async () => {
    const target = open('see [[Rocket notes')
    closeCompletion(target)
    await vi.waitFor(() => expect(completionStatus(target.state)).toBeNull())

    backspace(target)
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))
    expect(popup()?.textContent).toContain('Rocket notes')
  })

  it('stays shut when the deletion leaves nothing a source wants', async () => {
    const target = open('just some prose here')
    backspace(target)
    // Long enough for the activation delay plus a source round trip; the
    // claim is that it settles closed, not that it never blinks.
    await vi.waitFor(() => expect(completionStatus(target.state)).toBeNull())
    expect(popup()).toBeNull()
  })

  /**
   * Only a DELETION. Asserted with the plugin's own typing activation turned
   * OFF, which is the one arrangement where the two can be told apart — with
   * it on, every insertion opens a list either way and the case would pass
   * over an extension that reacted to everything.
   */
  it('does not react to an insertion', async () => {
    // A negative claim has nothing of its own to wait for, so it is measured
    // against a CONTROL rather than against a duration: type (which must not
    // ask), then delete (which must), and wait on the deletion's own
    // activation. One source call means the insertion produced none.
    //
    // The plugin's own typing activation is turned OFF for it, the one
    // arrangement where the two can be told apart — with it on, an insertion
    // asks either way and the case would pass over an extension that reacted
    // to everything.
    const asked = { calls: 0 }
    vi.useFakeTimers()
    const target = open('ship it ', { activateOnTyping: false, source: countingSource(asked) })

    const at = target.state.selection.main.head
    target.dispatch({
      changes: { from: at, insert: ':rocke' },
      selection: { anchor: at + 6 },
      userEvent: 'input.type',
    })
    await pastActivation()
    expect(asked.calls).toBe(0)

    // The control: a deletion in the same place MUST ask, so the zero above
    // is this extension declining an insertion rather than nothing working.
    backspace(target)
    await pastActivation()
    expect(asked.calls).toBe(1)
  })

  /**
   * The already-open guard, pinned as what it saves rather than as a
   * behaviour — restarting an open query is invisible on screen and costs a
   * source call each time. Measured at the time of writing: 2 with the guard
   * against 5 without, over the same four backspaces, each call a scan of
   * the 1914-row emoji index.
   */
  it('does not re-run a source while its list is already open', async () => {
    const asked = { calls: 0 }
    vi.useFakeTimers()
    const target = open('ship it :rocket', { source: countingSource(asked) })
    startCompletion(target)
    await pastActivation()
    expect(asked.calls).toBe(1)

    // Three backspaces an OPEN list absorbs through `validFor`, each given
    // its own activation window so the plugin cannot coalesce them.
    for (let n = 0; n < 3; n += 1) {
      backspace(target)
      await pastActivation()
    }

    // The open, and nothing since. Without the guard each backspace restarts
    // the query and this reads 4 — every one of them a scan of the 1914-row
    // emoji index in the real source this stands in for.
    expect(asked.calls).toBe(1)
  })

  /** Deleting at the very start of a document must not read past position 0. */
  it('survives a deletion with nothing before the caret', async () => {
    const target = open('x')
    backspace(target)
    await vi.waitFor(() => expect(target.state.doc.toString()).toBe(''))
    expect(popup()).toBeNull()
  })

  /** The plugin's own opener still works; this extension is additive. */
  it('leaves an explicitly started completion alone', async () => {
    const target = open('ship it :rocke')
    startCompletion(target)
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))
    backspace(target)
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))
  })
})

/**
 * The extension set above is this file's own, so it can only say the
 * extension works. Whether either HOST installs it is a different question,
 * and the one that has gone wrong here before — a completion regression
 * shipped once because every test built its own array and none mounted the
 * real editor.
 */
describe('both editing hosts install it', () => {
  const popupText = () => document.querySelector('.cm-tooltip-autocomplete')?.textContent ?? ''

  it('reopens in the document editor', async () => {
    render(<MarkdownEditor value={'ship it :rocket: today'} onChange={vi.fn()} />)
    const content = document.querySelector('.cm-content') as HTMLElement
    await userEvent.click(content)
    await userEvent.keyboard('{Home}{ArrowRight>16/}')
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull()

    await userEvent.keyboard('{Backspace}')
    await vi.waitFor(() => expect(popupText()).toContain('rocket'))
  })

  it('reopens in a canvas node editor', async () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'text', x: 100, y: 100, width: 260, height: 120, text: 'go :rocket:' },
      ],
      edges: [],
    }
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor defaultTool="select" canvas={canvas} onChange={vi.fn()} theme="light" />
      </div>,
    )
    const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    const r = root.getBoundingClientRect()
    const at = { clientX: r.left + 200, clientY: r.top + 150 }
    for (const _ of [0, 1]) {
      fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
      fireEvent.pointerUp(root, { pointerId: 1, ...at })
    }
    await vi.waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull()

    // Opening the editor leaves the caret at the end of the body, which is
    // the closing colon — so one backspace lands inside the name.
    await userEvent.keyboard('{Backspace}')
    await vi.waitFor(() => expect(popupText()).toContain('rocket'))
  })
})
