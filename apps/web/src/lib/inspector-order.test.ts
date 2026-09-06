/**
 * `INSPECTOR_ORDER` holds every inspector member, once.
 *
 * `satisfies readonly InspectorKind[]` only checks that each entry IS a
 * member — it says nothing about a member left out or written twice, and
 * both fail silently: a missing member simply stops being drawn in the
 * header, which looks exactly like a document that does not offer it.
 * `INSPECTOR_CHROME` is the declared surface, so it is what the order is
 * measured against rather than a second hand-kept list.
 */

import { describe, expect, it } from 'vitest'
import { INSPECTOR_CHROME, INSPECTOR_ORDER } from './inspector.js'

describe('INSPECTOR_ORDER', () => {
  it('names every member of the declared surface', () => {
    expect([...INSPECTOR_ORDER].sort()).toEqual(Object.keys(INSPECTOR_CHROME).sort())
  })

  it('names each one once', () => {
    expect(new Set(INSPECTOR_ORDER).size).toBe(INSPECTOR_ORDER.length)
  })
})
