import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WhiteboardCommandDeps } from './types.js'
import { useWhiteboardCommands } from './use-whiteboard-commands.js'

function deps(overrides: Partial<WhiteboardCommandDeps> = {}): WhiteboardCommandDeps {
  return {
    provider: { kind: 'browser' },
    canvas: { documentId: 'c1', name: 'Canvas 1' },
    ...overrides,
  }
}

describe('useWhiteboardCommands', () => {
  it('returns a referentially stable commands object across rerenders', () => {
    const { result, rerender } = renderHook(
      (d: WhiteboardCommandDeps) => useWhiteboardCommands(d),
      {
        initialProps: deps(),
      },
    )
    const first = result.current

    rerender(deps({ canvas: { documentId: 'c2', name: 'Canvas 2' } }))
    rerender(
      deps({
        provider: {
          kind: 'daemon',
          daemonBaseUrl: 'http://x',
        },
      }),
    )

    expect(result.current).toBe(first)
  })
})
