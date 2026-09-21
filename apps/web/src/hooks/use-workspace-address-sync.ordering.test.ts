// @vitest-environment node
/**
 * The daemon-page request-storm fix (bce51ca6) depends on an ordering
 * invariant no runtime test reproduces (a jsdom regression test was
 * attempted and discarded as vacuous — it passed identically with the fix
 * reverted, since jsdom's act()-batched scheduling never surfaces the
 * same-commit race). React flushes the state->URL and URL->state effects in
 * ONE commit, in declaration order, whenever a stray address rewrite lands:
 * `lastRouteSyncPathRef` must be hoisted above both effects, stamped with
 * the about-to-be-superseded pathname BEFORE the state->URL effect
 * navigates, and the URL->state effect (declared after, so it runs after in
 * the same commit) must read that mark before it re-parses the same stale
 * `location.pathname` back into `daemonView`.
 *
 * A refactor that reorders the two `useEffect` calls, or moves the stamp
 * after `navigate()`, recreates the storm without failing any other test —
 * so this pins the source positions directly rather than the runtime
 * behaviour nothing here can reproduce.
 *
 * It reads `use-workspace-address-sync.ts`, where both effects now live.
 * They were in `App`'s body when this was written; the invariant did not
 * change, and having them in one file rather than three hundred lines apart
 * is what makes it readable at all. A custom hook registers its effects in
 * the caller's commit, in the order written here, so "declared after" still
 * means "runs after".
 */
import { describe, expect, it } from 'vitest'
import hookSource from './use-workspace-address-sync.ts?raw'

describe('the same-commit route-sync ordering the ping-pong fix depends on', () => {
  it('hoists the shared ref, stamps before navigating, and declares the reader after the writer', () => {
    const refDecl = hookSource.indexOf('const lastRouteSyncPathRef = useRef(location.pathname)')
    expect(refDecl).toBeGreaterThan(-1)

    const stamp = hookSource.indexOf('lastRouteSyncPathRef.current = location.pathname', refDecl)
    expect(stamp).toBeGreaterThan(-1)

    const stateToUrlNavigate = hookSource.indexOf(
      'navigate(path, { replace: isFirstSync || namingTheSameIndex })',
      refDecl,
    )
    expect(stateToUrlNavigate).toBeGreaterThan(-1)

    const urlToStateSkip = hookSource.indexOf(
      'if (lastRouteSyncPathRef.current === location.pathname) return',
      stateToUrlNavigate,
    )
    expect(urlToStateSkip).toBeGreaterThan(-1)

    // The ref is shared, so it must exist before either effect reads/writes it.
    expect(refDecl).toBeLessThan(stamp)
    // Stamp-before-navigate: the mark must land before the very navigate()
    // call it exists to protect the URL->state effect against.
    expect(stamp).toBeLessThan(stateToUrlNavigate)
    // Declaration order IS commit order: the effect that reads the mark
    // must be declared after the effect that writes it, so React runs the
    // write before the read whenever both fire in the same commit.
    expect(stateToUrlNavigate).toBeLessThan(urlToStateSkip)
  })
})
