import { afterEach, expect, it, vi } from 'vitest'
import { announceOnCanvas, canvasAnnouncement } from './canvas-announcer.js'

afterEach(() => {
  vi.useRealTimers()
})

it('the same words twice in a row still change the text a reader watches', () => {
  vi.useFakeTimers()
  announceOnCanvas('Note added')
  const first = canvasAnnouncement()
  announceOnCanvas('Note added')
  expect(canvasAnnouncement()).not.toBe(first)
  expect(canvasAnnouncement().trim()).toBe('Note added')
  vi.runAllTimers()
})
