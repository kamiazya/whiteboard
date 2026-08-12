import { beforeEach, describe, expect, it, vi } from 'vitest'
import { celebrate } from './celebrate.js'

const confettiMock = vi.hoisted(() => vi.fn())
vi.mock('canvas-confetti', () => ({ default: confettiMock }))

beforeEach(() => {
  confettiMock.mockReset().mockResolvedValue(undefined)
})

describe('celebrate', () => {
  it('fires one burst in the brand palette with reduced-motion suppression', async () => {
    await celebrate()
    expect(confettiMock).toHaveBeenCalledTimes(1)
    const opts = confettiMock.mock.calls[0][0]
    expect(opts.colors[0]).toBe('#3b6ecc')
    expect(opts.disableForReducedMotion).toBe(true)
    expect(opts.origin).toBeUndefined()
  })

  it('converts the origin element center to viewport fractions', async () => {
    const el = document.createElement('span')
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 20, height: 10 }) as DOMRect
    vi.stubGlobal('innerWidth', 1000)
    vi.stubGlobal('innerHeight', 500)
    try {
      await celebrate(el)
      expect(confettiMock.mock.calls[0][0].origin).toEqual({ x: 0.11, y: 0.11 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never throws when the burst itself fails', async () => {
    confettiMock.mockRejectedValue(new Error('canvas exploded'))
    await expect(celebrate()).resolves.toBeUndefined()
  })
})
