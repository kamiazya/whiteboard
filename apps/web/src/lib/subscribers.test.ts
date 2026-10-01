import { describe, expect, it, vi } from 'vitest'
import { createSubscribers } from './subscribers.js'

describe('createSubscribers', () => {
  it('emits to every subscribed listener with the arguments, in subscription order', () => {
    const subscribers = createSubscribers<[string, number]>()
    const calls: string[] = []
    subscribers.subscribe((a, b) => calls.push(`first:${a}:${String(b)}`))
    subscribers.subscribe((a, b) => calls.push(`second:${a}:${String(b)}`))

    subscribers.emit('x', 1)

    expect(calls).toEqual(['first:x:1', 'second:x:1'])
  })

  it('stops calling a listener once its unsubscribe ran, and a second unsubscribe is harmless', () => {
    const subscribers = createSubscribers()
    const listener = vi.fn()
    const unsubscribe = subscribers.subscribe(listener)
    subscribers.emit()
    unsubscribe()
    unsubscribe()
    subscribers.emit()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('lets a listener unsubscribe itself during an emit without disturbing the others', () => {
    const subscribers = createSubscribers()
    const after = vi.fn()
    const unsubscribeSelf = subscribers.subscribe(() => unsubscribeSelf())
    subscribers.subscribe(after)

    subscribers.emit()
    subscribers.emit()

    expect(after).toHaveBeenCalledTimes(2)
  })
})
