// Matcher semantics for the shortcut catalog (shortcuts.ts): specs can claim
// a Cmd/Ctrl ("mod") or Alt modifier explicitly — the capability every
// clipboard-family binding needs. No product binding relies on it alone, so
// the cases run against synthetic specs via the exported matcher.
import { describe, expect, it } from 'vitest'
import { EDITOR_SHORTCUTS, findShortcutIn, type ShortcutSpec } from './shortcuts.js'

const KEY_C = { code: 'KeyC', key: 'c' }

function event(over: Partial<KeyEventLike>): KeyEventLike {
  return {
    code: '',
    key: '',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    target: null,
    ...over,
  }
}
interface KeyEventLike {
  readonly code: string
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly target: EventTarget | null
}

const MOD_SPEC: ShortcutSpec = {
  id: 'reorder-forward', // any table id — the matcher only reads matching fields
  section: 'Arrange',
  keys: ['c'],
  mod: true,
  display: 'Cmd+C',
  description: 'test spec',
}

const PLAIN_SPEC: ShortcutSpec = {
  id: 'reorder-backward',
  section: 'Arrange',
  codes: ['BracketLeft'],
  shift: false,
  display: '[',
  description: 'test spec',
}

describe('findShortcutIn modifier semantics', () => {
  it('a mod:true spec fires on Cmd (metaKey) AND on Ctrl (ctrlKey), never on a plain press', () => {
    const specs = [MOD_SPEC]
    expect(findShortcutIn(specs, event({ ...KEY_C, metaKey: true }), 'select')).toBe(MOD_SPEC)
    expect(findShortcutIn(specs, event({ ...KEY_C, ctrlKey: true }), 'select')).toBe(MOD_SPEC)
    expect(findShortcutIn(specs, event({ ...KEY_C }), 'select')).toBeUndefined()
  })

  it('a mod:true spec still rejects a stray Alt, and alt:true requires Alt', () => {
    const specs = [MOD_SPEC]
    expect(
      findShortcutIn(specs, event({ ...KEY_C, metaKey: true, altKey: true }), 'select'),
    ).toBeUndefined()

    const altSpec: ShortcutSpec = { ...MOD_SPEC, mod: undefined, alt: true, display: 'Alt+C' }
    expect(findShortcutIn([altSpec], event({ ...KEY_C, altKey: true }), 'select')).toBe(altSpec)
    expect(findShortcutIn([altSpec], event({ ...KEY_C }), 'select')).toBeUndefined()
  })

  it('a spec WITHOUT mod keeps the historic behavior: any held meta/ctrl/alt suppresses it', () => {
    const specs = [PLAIN_SPEC]
    const plain = event({ code: 'BracketLeft', key: '[' })
    expect(findShortcutIn(specs, plain, 'select')).toBe(PLAIN_SPEC)
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(
        findShortcutIn(specs, event({ code: 'BracketLeft', key: '[', [modifier]: true }), 'select'),
      ).toBeUndefined()
    }
  })

  it('mod matching stays case-insensitive on key (Shift+Cmd chords report uppercase keys)', () => {
    expect(
      findShortcutIn(
        [MOD_SPEC],
        event({ code: 'KeyC', key: 'C', metaKey: true, shiftKey: true }),
        'select',
      ),
    ).toBe(MOD_SPEC)
  })

  it('never fires from a text-entry surface, mod or not', () => {
    const textarea = document.createElement('textarea')
    expect(
      findShortcutIn([MOD_SPEC], event({ ...KEY_C, metaKey: true, target: textarea }), 'select'),
    ).toBeUndefined()
  })

  it.each([
    'input',
    'textarea',
  ])('never fires from <%s>, and still fires from a plain element', (tag) => {
    const spec: ShortcutSpec = {
      id: 'reorder-forward',
      section: 'Arrange',
      keys: ['x'],
      display: 'X',
      description: 'test spec',
    }
    const typed = event({ code: 'KeyX', key: 'x', target: document.createElement(tag) })
    expect(findShortcutIn([spec], typed, 'select')).toBeUndefined()
    const plain = event({ code: 'KeyX', key: 'x', target: document.createElement('div') })
    expect(findShortcutIn([spec], plain, 'select')).toBe(spec)
  })

  it('tool scoping applies to mod specs like any other', () => {
    const scoped: ShortcutSpec = { ...MOD_SPEC, tools: ['select'] }
    expect(findShortcutIn([scoped], event({ ...KEY_C, metaKey: true }), 'hand')).toBeUndefined()
  })

  it('regression: the pre-modifier catalog entries still declare neither mod nor alt', () => {
    // The z-order and inline-handled bindings predate modifier support and
    // must keep firing exactly as before; only chords added SINCE (e.g.
    // duplicate-selection) may claim a modifier.
    const preModifierIds = [
      'reorder-forward',
      'reorder-backward',
      'reorder-front',
      'reorder-back',
      'delete-selection',
      'cancel',
      'space-pan',
      'nudge-selection',
    ]
    for (const id of preModifierIds) {
      const spec = EDITOR_SHORTCUTS.find((entry) => entry.id === id)
      expect(spec).toBeDefined()
      expect(spec?.mod).toBeUndefined()
      expect(spec?.alt).toBeUndefined()
    }
  })
})

// The catalog calls itself "the ONE place every binding is declared", and
// the overlay editors' exit verbs were missing from it — which is how
// someone hunting for "how do I save while editing?" found nothing. They
// are declared now, and this pins the part that matters: declaring them
// changed no behaviour.
//
// There is deliberately no scan enforcing the catalog's own claim. The
// overlay editors' keymaps carry the markdown grammar's style bindings
// (Mod-b, Mod-i, list continuation) alongside the two exit verbs, and a
// scan that cannot tell them apart would demand declaring every one — a
// guard that cries wolf is worse than the prose it replaces.
describe('the overlay editors bindings are declared but never dispatched', () => {
  const declared = (id: string) => EDITOR_SHORTCUTS.find((spec) => spec.id === id)

  it('the node editor commit and cancel are both in the catalog', () => {
    expect(declared('commit-text-edit')?.display).toBe('Cmd+Enter')
    expect(declared('cancel')?.display).toBe('Esc')
  })

  it('both are inline-handled, so the matcher never claims them', () => {
    for (const id of ['commit-text-edit', 'cancel']) {
      expect(declared(id)?.handledInline, `${id} must stay declared-only`).toBe(true)
    }
    // Cmd+Enter from anywhere: the matcher skips inline-handled specs.
    expect(
      findShortcutIn(EDITOR_SHORTCUTS, event({ key: 'Enter', metaKey: true }), 'select'),
    ).toBeUndefined()
  })
})

describe('the tool and new-note letters', () => {
  const press = (key: string, over: Partial<KeyEventLike> = {}) =>
    event({ key, code: `Key${key.toUpperCase()}`, ...over })
  const LETTERS = [
    ['v', 'tool-select'],
    ['h', 'tool-hand'],
    ['c', 'tool-connect'],
    ['d', 'tool-draw'],
    ['n', 'new-note'],
  ] as const

  it.each(LETTERS)('%s resolves to %s in every tool', (key, id) => {
    for (const tool of ['select', 'hand', 'connect', 'draw'] as const) {
      expect(findShortcutIn(EDITOR_SHORTCUTS, press(key), tool)?.id).toBe(id)
    }
  })

  it('a held Cmd or Ctrl leaves the letter to the clipboard and duplicate chords', () => {
    for (const [key] of LETTERS) {
      for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
        const found = findShortcutIn(EDITOR_SHORTCUTS, press(key, mod), 'select')
        expect(found?.id.startsWith('tool-') || found?.id === 'new-note').not.toBe(true)
      }
    }
  })

  it('does not fire while typing in a text field', () => {
    const input = document.createElement('input')
    expect(
      findShortcutIn(EDITOR_SHORTCUTS, press('v', { target: input }), 'select'),
    ).toBeUndefined()
  })

  it('no two plain table rows answer the same press', () => {
    for (const [key] of LETTERS) {
      const matches = EDITOR_SHORTCUTS.filter(
        (spec) =>
          spec.handledInline !== true &&
          spec.mod !== true &&
          spec.keys?.some((k) => k.toLowerCase() === key),
      )
      expect(matches, key).toHaveLength(1)
    }
  })
})

describe('node traversal rows', () => {
  const key = (over: Partial<KeyEventLike>) => event({ code: 'Tab', key: 'Tab', ...over })

  it('Tab and Shift+Tab are two rows, live in the select tool only', () => {
    expect(findShortcutIn(EDITOR_SHORTCUTS, key({}), 'select')?.id).toBe('select-next-node')
    expect(findShortcutIn(EDITOR_SHORTCUTS, key({ shiftKey: true }), 'select')?.id).toBe(
      'select-previous-node',
    )
    expect(findShortcutIn(EDITOR_SHORTCUTS, key({}), 'connect')).toBeUndefined()
  })

  it('Cmd/Ctrl+Arrow selects a neighbour while a bare arrow stays the nudge', () => {
    const arrow = { code: 'ArrowRight', key: 'ArrowRight' }
    expect(findShortcutIn(EDITOR_SHORTCUTS, event({ ...arrow, ctrlKey: true }), 'select')?.id).toBe(
      'select-adjacent-node',
    )
    expect(findShortcutIn(EDITOR_SHORTCUTS, event({ ...arrow }), 'select')).toBeUndefined()
  })

  it('Enter and F2 edit, but Cmd+Enter stays the editor commit', () => {
    expect(findShortcutIn(EDITOR_SHORTCUTS, event({ code: 'F2', key: 'F2' }), 'select')?.id).toBe(
      'edit-selected-node',
    )
    expect(
      findShortcutIn(
        EDITOR_SHORTCUTS,
        event({ code: 'Enter', key: 'Enter', metaKey: true }),
        'select',
      ),
    ).toBeUndefined()
  })
})
