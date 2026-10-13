/**
 * What the source pane DRAWS for a proposal, against a real view: the
 * passage's mark and the gutter marker beside its line.
 *
 * Placement is `proposal-decorations.test.ts`'s subject and the press-opens-
 * the-card flow is the browser test's. What sits between them is the state a
 * marker carries — whether its line holds the selected change, whether any
 * passage on it has drifted, how many changes it stands for — and whether
 * the marker's DOM follows when that state moves. CodeMirror reuses a
 * marker's DOM whenever `eq` says nothing changed, so a field missing from
 * `eq` is a marker that goes on saying what it said before.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Proposal, ProposedChange } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ProposalProjection,
  proposalDecorations,
  setProposalProjection,
} from './proposal-decorations.js'

const BODY = 'Ship on Thursday. Review on Friday.\nSecond line stays plain.'

let view: EditorView | undefined

afterEach(() => {
  view?.destroy()
  view = undefined
  document.body.replaceChildren()
})

function open(doc = BODY): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [proposalDecorations()] }),
  })
  return view
}

/** A body change over `exact`; `assumed` differing from it is a conflict. */
function passage(id: string, exact: string, assumed = exact): ProposedChange {
  const start = BODY.indexOf(exact)
  return {
    id,
    op: 'body.replace',
    status: 'open',
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    text: `${exact}!`,
    assumed,
  }
}

function project(target: EditorView, projection: ProposalProjection): void {
  target.dispatch({ effects: setProposalProjection.of(projection) })
}

function proposals(...changes: ProposedChange[]): Proposal[] {
  return [{ id: 'p1', changes }]
}

/** Queried fresh each time: a marker whose state changed is a new node. */
function markers(target: EditorView): HTMLElement[] {
  return [...target.dom.querySelectorAll<HTMLElement>('.cm-proposal-gutter-marker')]
}

function onlyMarker(target: EditorView): HTMLElement {
  const found = markers(target)
  expect(found).toHaveLength(1)
  return found[0] as HTMLElement
}

describe('the gutter marker for a line holding two passages', () => {
  it('names the first passage and counts both', () => {
    const target = open()
    project(target, {
      proposals: proposals(passage('c1', 'Thursday'), passage('c2', 'Friday')),
      selectedChangeId: null,
    })
    const marker = onlyMarker(target)
    expect(marker.dataset.changeId).toBe('c1')
    expect(marker.dataset.passages).toBe('2')
    expect(marker.getAttribute('aria-label')).toBe('2 proposed changes on this line')
    expect(marker.dataset.selected).toBeUndefined()
    expect(marker.dataset.conflicted).toBeUndefined()
  })

  it('is selected and conflicted when either passage is, not only the first', () => {
    const target = open()
    project(target, {
      proposals: proposals(passage('c1', 'Thursday'), passage('c2', 'Friday', 'Saturday')),
      selectedChangeId: 'c2',
    })
    const marker = onlyMarker(target)
    expect(marker.dataset.selected).toBe('true')
    expect(marker.dataset.conflicted).toBe('true')
    expect(marker.getAttribute('aria-label')).toBe(
      '2 proposed changes on this line, on words that have since changed',
    )
  })

  it('is conflicted when its first passage is and its second is not', () => {
    const target = open()
    project(target, {
      proposals: proposals(passage('c1', 'Thursday', 'Wednesday'), passage('c2', 'Friday')),
      selectedChangeId: null,
    })
    expect(onlyMarker(target).dataset.conflicted).toBe('true')
  })
})

describe('a line holding one passage', () => {
  it('reads as a single change and carries no count', () => {
    const target = open()
    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: null })
    const marker = onlyMarker(target)
    expect(marker.getAttribute('aria-label')).toBe('A proposed change')
    expect(marker.dataset.passages).toBeUndefined()
  })

  it('marks the selected passage and only that one', () => {
    const target = open(`${BODY}\nThursday again.`)
    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: 'c1' })
    const marks = [...target.dom.querySelectorAll<HTMLElement>('.cm-proposal')]
    expect(marks.map((mark) => mark.dataset.changeId)).toEqual(['c1'])
    expect(marks[0]?.classList.contains('cm-proposal-selected')).toBe(true)

    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: 'other' })
    const after = target.dom.querySelector<HTMLElement>('.cm-proposal')
    expect(after?.classList.contains('cm-proposal-selected')).toBe(false)
  })
})

describe('the marker follows its state when the projection moves', () => {
  it('redraws on a change of selection', () => {
    const target = open()
    const changes = proposals(passage('c1', 'Thursday'))
    project(target, { proposals: changes, selectedChangeId: null })
    expect(onlyMarker(target).dataset.selected).toBeUndefined()
    project(target, { proposals: changes, selectedChangeId: 'c1' })
    expect(onlyMarker(target).dataset.selected).toBe('true')
  })

  it('redraws on a change of which passage it names', () => {
    const target = open()
    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: null })
    project(target, { proposals: proposals(passage('c9', 'Thursday')), selectedChangeId: null })
    expect(onlyMarker(target).dataset.changeId).toBe('c9')
  })

  it('redraws on a change of count', () => {
    const target = open()
    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: null })
    project(target, {
      proposals: proposals(passage('c1', 'Thursday'), passage('c2', 'Friday')),
      selectedChangeId: null,
    })
    expect(onlyMarker(target).dataset.passages).toBe('2')
  })

  it('redraws on a change of conflict', () => {
    const target = open()
    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: null })
    project(target, {
      proposals: proposals(passage('c1', 'Thursday', 'Wednesday')),
      selectedChangeId: null,
    })
    expect(onlyMarker(target).dataset.conflicted).toBe('true')
  })
})

describe('a press on the gutter', () => {
  function press(element: Element): MouseEvent {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    element.dispatchEvent(event)
    return event
  }

  it('on a marker holds back the default', () => {
    const target = open()
    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: null })
    expect(press(onlyMarker(target)).defaultPrevented).toBe(true)
  })

  it('beside the marker is left to the editor', () => {
    const target = open()
    project(target, { proposals: proposals(passage('c1', 'Thursday')), selectedChangeId: null })
    const gutter = target.dom.querySelector('.cm-proposal-gutter')
    expect(gutter).not.toBeNull()
    expect(press(gutter as Element).defaultPrevented).toBe(false)
  })
})
