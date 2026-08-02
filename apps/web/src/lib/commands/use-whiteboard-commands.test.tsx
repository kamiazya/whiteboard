import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BROWSER_LOCAL_CAPABILITIES } from '../provider.js'
import type { WhiteboardCommandDeps } from './types.js'
import { useWhiteboardCommands } from './use-whiteboard-commands.js'

function deps(overrides: Partial<WhiteboardCommandDeps> = {}): WhiteboardCommandDeps {
  return {
    provider: { kind: 'browser-local', capabilities: BROWSER_LOCAL_CAPABILITIES },
    canvas: { canvasId: 'c1', name: 'Canvas 1' },
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

    rerender(deps({ canvas: { canvasId: 'c2', name: 'Canvas 2' } }))
    rerender(
      deps({
        provider: {
          kind: 'local-daemon',
          daemonBaseUrl: 'http://x',
          capabilities: BROWSER_LOCAL_CAPABILITIES,
        },
      }),
    )

    expect(result.current).toBe(first)
  })
})
