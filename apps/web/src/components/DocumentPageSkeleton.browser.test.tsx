import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../index.css'
import { DocumentPageSkeleton } from './DocumentPageSkeleton.js'

// Composite `fills` on a real canvas, so any CSS colour syntax (oklch, alpha)
// is judged by the pixel the user sees.
function paintedChannel(fills: string[]): number {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')
  for (const fill of fills) {
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, 1, 1)
  }
  return ctx.getImageData(0, 0, 1, 1).data[0] ?? 0
}

// The pulse animation dims a placeholder to half its alpha at the trough, so
// the floor is judged against that worst frame.
function troughLift(ground: string, fill: string): number {
  const dimmed = `color-mix(in oklab, ${fill} 50%, transparent)`
  return paintedChannel([ground, dimmed]) - paintedChannel([ground])
}

describe('DocumentPageSkeleton in the dark theme', () => {
  afterEach(() => {
    cleanup()
    document.documentElement.classList.remove('dark')
  })

  it('keeps every placeholder visibly lighter than the ground at the pulse trough', async () => {
    document.documentElement.classList.add('dark')
    const { container } = render(<DocumentPageSkeleton label="Loading canvas" />)
    const status = container.querySelector('[role="status"]') as HTMLElement
    await vi.waitFor(() => expect(getComputedStyle(status).opacity).toBe('1'))
    const ground = getComputedStyle(document.body).backgroundColor
    const area = status.querySelector('.flex-1 > div') as Element
    const bar = status.querySelector('.animate-pulse') as Element
    expect(troughLift(ground, getComputedStyle(area).backgroundColor)).toBeGreaterThanOrEqual(8)
    expect(troughLift(ground, getComputedStyle(bar).backgroundColor)).toBeGreaterThanOrEqual(8)
  })
})
