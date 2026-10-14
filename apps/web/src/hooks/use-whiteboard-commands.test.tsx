import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WhiteboardCommandDeps } from '../lib/commands/types.js'
import { useWhiteboardCommands } from './use-whiteboard-commands.js'

function deps(overrides: Partial<WhiteboardCommandDeps> = {}): WhiteboardCommandDeps {
  return {
    provider: { kind: 'browser' },
    canvas: { workspaceId: 'w1', documentId: 'c1', path: 'p.md' },
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

    rerender(deps({ canvas: { workspaceId: 'w1', documentId: 'c2', path: 'q.md' } }))
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
