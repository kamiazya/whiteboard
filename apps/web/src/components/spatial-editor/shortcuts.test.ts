// Matcher semantics for the shortcut catalog (shortcuts.ts). Slice 0a of
// the editor-completeness plan: specs can now claim a Cmd/Ctrl ("mod") or
// Alt modifier explicitly — the capability every clipboard-family binding
// needs. No product binding uses it yet in this slice, so the cases run
// against synthetic specs via the exported matcher.
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
  keys: ['c'],
  mod: true,
  display: 'Cmd+C',
  description: 'test spec',
}

const PLAIN_SPEC: ShortcutSpec = {
  id: 'reorder-backward',
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

  it('tool scoping applies to mod specs like any other', () => {
    const scoped: ShortcutSpec = { ...MOD_SPEC, tools: ['select'] }
    expect(findShortcutIn([scoped], event({ ...KEY_C, metaKey: true }), 'hand')).toBeUndefined()
  })

  it('regression: no existing catalog entry declares mod/alt, so the table is unaffected', () => {
    for (const spec of EDITOR_SHORTCUTS) {
      expect(spec.mod).toBeUndefined()
      expect(spec.alt).toBeUndefined()
    }
  })
})
