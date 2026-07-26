// React 19's scheduler (MessageChannel/setImmediate based) can still have
// deferred work in flight when a test — or a whole test file — finishes.
// If that work fires after jsdom's environment teardown, `window` is
// already gone and the callback throws a ReferenceError that surfaces as an
// "unhandled error" attributed to whichever test happened to be running
// next. Giving the scheduler a bounded number of real macrotask turns to
// drain, while the environment is still alive, removes the race instead of
// shrinking it.
//
// Deliberately channel-agnostic: it waits on setImmediate + setTimeout(0)
// each turn rather than reaching into scheduler/react-dom internals, so a
// future React scheduling-channel change degrades this to a harmless no-op
// instead of silently breaking.
const DEFAULT_DRAIN_TURNS = 5

export async function drainSchedulerMacrotasks(turns = DEFAULT_DRAIN_TURNS): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
