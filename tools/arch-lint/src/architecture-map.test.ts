import { describe, expect, it } from 'vitest'
import { exemptedBoundaryViolationKinds } from './architecture-map.js'

describe('exemptedBoundaryViolationKinds', () => {
  it('exempts workspace from loro-crdt-import via allowedThirdParty, not an explicit list', () => {
    const kinds = exemptedBoundaryViolationKinds('@kamiazya/whiteboard-loro-adapter')
    expect(kinds.has('loro-crdt-import')).toBe(true)
    expect(kinds.has('dom-global')).toBe(false)
  })

  it('exempts canvas-viewer from dom-global and node-ambient-global but not node-builtin-import', () => {
    const kinds = exemptedBoundaryViolationKinds('@kamiazya/whiteboard-canvas-viewer')
    expect(kinds.has('dom-global')).toBe(true)
    expect(kinds.has('node-ambient-global')).toBe(true)
    expect(kinds.has('node-builtin-import')).toBe(false)
    expect(kinds.has('inversify-import')).toBe(false)
  })

  it('returns an empty set for a package with no exemptions', () => {
    const kinds = exemptedBoundaryViolationKinds('@kamiazya/whiteboard-model')
    expect(kinds.size).toBe(0)
  })

  it('returns an empty set for an unmapped package name', () => {
    const kinds = exemptedBoundaryViolationKinds('@kamiazya/not-a-real-package')
    expect(kinds.size).toBe(0)
  })
})
