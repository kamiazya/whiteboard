import { describe, expect, it, vi } from 'vitest'
import { assertNoSetStateInRenderWarning } from './no-setstate-in-render.js'

function spyWithCalls(calls: unknown[][]): ReturnType<typeof vi.spyOn> {
  const target = { error: (..._args: unknown[]) => {} }
  const spy = vi.spyOn(target, 'error')
  for (const args of calls) {
    target.error(...args)
  }
  return spy
}

describe('assertNoSetStateInRenderWarning', () => {
  it('passes when no console.error calls were captured', () => {
    const spy = spyWithCalls([])

    expect(() => assertNoSetStateInRenderWarning(spy)).not.toThrow()
  })

  it('passes when an unrelated console.error call was captured', () => {
    const spy = spyWithCalls([['Warning: Failed prop type: some other warning']])

    expect(() => assertNoSetStateInRenderWarning(spy)).not.toThrow()
  })

  it('fails on the "Cannot update a component while rendering a different component" phrasing', () => {
    const spy = spyWithCalls([
      [
        'Warning: Cannot update a component (`DocumentList`) while rendering a different component (`DocumentRow`).',
      ],
    ])

    expect(() => assertNoSetStateInRenderWarning(spy)).toThrow()
  })

  it('fails on the "Cannot update a component while rendering a different component" phrasing without a backtick-quoted component name', () => {
    const spy = spyWithCalls([['Cannot update a component while rendering a different component.']])

    expect(() => assertNoSetStateInRenderWarning(spy)).toThrow()
  })

  it('fails on the generic "setState ... during ... render" phrasing', () => {
    const spy = spyWithCalls([
      ['Warning: Cannot update state (via setState) during an existing render.'],
    ])

    expect(() => assertNoSetStateInRenderWarning(spy)).toThrow()
  })
})
