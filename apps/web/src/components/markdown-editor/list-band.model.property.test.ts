/**
 * The list band's three buttons as a state machine over ONE line, checked
 * by command sequences (fast-check model-based testing).
 *
 * A line is (marker, checkbox, text): the marker is none / bullet / ordered,
 * the checkbox none / open / done, and a checkbox needs a marker. The
 * buttons move the line through that space — this file's MODEL is the
 * transition table written out by hand, and the REAL side is the verbs'
 * CodeMirror commands run on the rendered line. After every press the real
 * line must equal the model's rendering, so any press whose semantics were
 * never decided (the empty line, a checked task, a bullet that is already a
 * task) fails here rather than surprising a thumb.
 *
 * The table, in words:
 *   bullet   — already a bullet: remove the marker (and with it the
 *              checkbox); otherwise become a bullet, keeping the checkbox.
 *   numbered — the same, for `1.`.
 *   task     — cycles the checkbox none -> open -> done -> none, adding a
 *              bullet marker when the line had none. Like the heading slot,
 *              one button walks the states and comes back round.
 * The text is never touched.
 */
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { selfContainedCommand, verb } from './editor-verbs.js'

type Marker = 'none' | 'bullet' | 'ordered'
type Checkbox = 'none' | 'open' | 'done'

interface Model {
  marker: Marker
  /** The number an ordered marker shows; a freshly made one shows 1. */
  number: number
  checkbox: Checkbox
  readonly text: string
}

interface Real {
  doc: string
}

/** The model's own rendering — the test's spelling of a line, not the code's. */
function render(model: Model): string {
  const marker =
    model.marker === 'none' ? '' : model.marker === 'bullet' ? '- ' : `${model.number}. `
  const checkbox = model.checkbox === 'none' ? '' : model.checkbox === 'open' ? '[ ] ' : '[x] '
  return `${marker}${checkbox}${model.text}`
}

function command(id: 'bullet-list' | 'ordered-list' | 'toggle-task'): StateCommand {
  const found = selfContainedCommand(verb(id))
  if (found === null) throw new Error(`${id} lost its command`)
  return found
}

/** Runs a verb on the real line with the caret at its end, the way a phone's caret sits after typing. */
function press(real: Real, id: 'bullet-list' | 'ordered-list' | 'toggle-task'): void {
  const state = EditorState.create({
    doc: real.doc,
    selection: EditorSelection.cursor(real.doc.length),
  })
  command(id)({
    state,
    dispatch: (tr) => {
      real.doc = tr.state.doc.toString()
    },
  })
}

class PressBullet implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    press(real, 'bullet-list')
    if (model.marker === 'bullet') {
      model.marker = 'none'
      model.checkbox = 'none'
    } else {
      model.marker = 'bullet'
    }
    expect(real.doc).toBe(render(model))
  }
  toString(): string {
    return 'bullet'
  }
}

class PressOrdered implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    press(real, 'ordered-list')
    if (model.marker === 'ordered') {
      model.marker = 'none'
      model.checkbox = 'none'
    } else {
      model.marker = 'ordered'
      model.number = 1
    }
    expect(real.doc).toBe(render(model))
  }
  toString(): string {
    return 'numbered'
  }
}

class PressTask implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    press(real, 'toggle-task')
    if (model.checkbox === 'none') {
      if (model.marker === 'none') model.marker = 'bullet'
      model.checkbox = 'open'
    } else if (model.checkbox === 'open') {
      model.checkbox = 'done'
    } else {
      model.checkbox = 'none'
    }
    expect(real.doc).toBe(render(model))
  }
  toString(): string {
    return 'task'
  }
}

const initialModel: fc.Arbitrary<Model> = fc
  .record({
    marker: fc.constantFrom<Marker>('none', 'bullet', 'ordered'),
    number: fc.integer({ min: 1, max: 9 }),
    checkbox: fc.constantFrom<Checkbox>('none', 'open', 'done'),
    text: fc.constantFrom('', 'ship it', 'weekly review', 'notes and more'),
  })
  // A checkbox needs a marker: that combination is not a line, so it is not a start state.
  .map((m) => (m.marker === 'none' ? { ...m, checkbox: 'none' as const } : m))

const presses = fc.commands([
  fc.constant(new PressBullet()),
  fc.constant(new PressOrdered()),
  fc.constant(new PressTask()),
])

describe('list band buttons as a line state machine', () => {
  fcTest.prop([initialModel, presses], withDefaults())(
    'every press sequence lands the real line exactly where the transition table says',
    (initial, cmds) => {
      fc.modelRun(() => ({ model: { ...initial }, real: { doc: render(initial) } }), cmds)
    },
  )
})
