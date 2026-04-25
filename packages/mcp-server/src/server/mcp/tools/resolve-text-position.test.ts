import { describe, expect, it } from 'vitest'
import { resolveTextPosition } from './resolve-text-position.js'

describe('resolveTextPosition', () => {
  it('case 347', () => {
    const r = resolveTextPosition({ target: { x: 100, y: 200 } })
    expect(r).toEqual({ x: 100, y: 200, textAlign: 'left' })
  })

  it('case 348', () => {
    const r = resolveTextPosition({ target: { x: 100, y: 200 }, width: 400, align: 'left' })
    expect(r).toEqual({ x: 100, y: 200, textAlign: 'left' })
  })

  it('case 349', () => {
    const r = resolveTextPosition({ target: { x: 500, y: 50 }, width: 400, align: 'center' })
    expect(r).toEqual({ x: 300, y: 50, textAlign: 'center' })
  })

  it('case 350', () => {
    const r = resolveTextPosition({ target: { x: 500, y: 50 }, width: 200, align: 'right' })
    expect(r).toEqual({ x: 300, y: 50, textAlign: 'right' })
  })

  it('case 351', () => {
    const r = resolveTextPosition({ target: { x: 100, y: 50 }, align: 'center' })
    expect(r).toEqual({ x: 100, y: 50, textAlign: 'center' })
  })

  it('case 352', () => {
    const r = resolveTextPosition({ target: { x: 100, y: 50 }, align: 'right' })
    expect(r).toEqual({ x: 100, y: 50, textAlign: 'right' })
  })

  it('case 353', () => {
    const r = resolveTextPosition({ target: { x: 0, y: 123.5 }, width: 50, align: 'center' })
    expect(r.y).toBe(123.5)
  })
})
