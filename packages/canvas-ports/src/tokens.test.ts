import { describe, expect, it } from 'vitest'
import { defineToken, TOKENS } from './tokens.js'

describe('TOKENS', () => {
  it('every TOKENS entry equals Symbol.for("whiteboard.ports."+key)', () => {
    for (const key of Object.keys(TOKENS) as Array<keyof typeof TOKENS>) {
      expect(TOKENS[key]).toBe(Symbol.for(`whiteboard.ports.${key}`))
    }
  })

  it('has exactly the four port interface names as keys', () => {
    expect(Object.keys(TOKENS).sort()).toEqual(
      ['BlobStore', 'CanvasDocStore', 'PresenceChannel', 'WorkspaceIndex'].sort(),
    )
  })

  it('defineToken produces a global-registry symbol identical across calls (module double-install safety)', () => {
    expect(defineToken('CanvasDocStore')).toBe(defineToken('CanvasDocStore'))
    expect(defineToken('CanvasDocStore')).toBe(TOKENS.CanvasDocStore)
  })

  it('each token is a genuine symbol', () => {
    for (const key of Object.keys(TOKENS) as Array<keyof typeof TOKENS>) {
      expect(typeof TOKENS[key]).toBe('symbol')
    }
  })
})
