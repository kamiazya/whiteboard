import { expect, vi } from 'vitest'

// React's warning text for an unguarded/cross-component setState-during-render
// violation. Distinct from the sanctioned "adjust state during render for the
// current component" pattern — a guarded `if (prev !== next) setPrev(next)`
// during render — which never triggers this. Wording has drifted across React 18/19 point releases,
// so the match stays tolerant of both phrasings.
const REACT_SETSTATE_IN_RENDER_RE =
  /Cannot update a component .*?while rendering a different component|Warning:.*setState.*during.*render/i

/**
 * Asserts that none of the `console.error` calls captured by `errorSpy` were a
 * React setState-in-render warning. Scoped to that specific warning (not "zero
 * console.error calls") so intentional error logging on other paths is allowed.
 */
export const assertNoSetStateInRenderWarning = vi.defineHelper(
  function assertNoSetStateInRenderWarning(errorSpy: ReturnType<typeof vi.spyOn>): void {
    const matchingCalls = (errorSpy.mock.calls as unknown[][]).filter((args) =>
      args.some((arg) => typeof arg === 'string' && REACT_SETSTATE_IN_RENDER_RE.test(arg)),
    )
    expect(matchingCalls).toEqual([])
  },
)
